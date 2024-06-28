/**
 * This file initializes and manages Layer Zero workers.
 * 
 * Inputs:
 * - Worker data from worker_threads.
 * - Configuration settings for Layer Zero.
 * - Logger service for logging information and errors.
 * 
 * Outputs:
 * - Initializes and manages Layer Zero worker threads.
 * - Logs status and errors related to the worker threads.
 */

import pino from 'pino';
import { workerData, MessagePort } from 'worker_threads';
import {
    JsonRpcProvider,
    Log,
    LogDescription,
    BytesLike,
    BigNumberish,
    keccak256,
    ethers,
    Filter,
} from 'ethers6';
import { Store } from '../../store/store.lib';
import { LayerZeroWorkerData } from './layer-zero';
import {
    MonitorInterface,
    MonitorStatus,
} from '../../monitor/monitor.interface';
import { ReceiveULN302__factory } from 'src/contracts/factories/ReceiveULN302__factory';
import { wait, tryErrorToString, paddedTo0xAddress } from 'src/common/utils';
import {
    ReceiveULN302,
    ReceiveULN302Interface,
    UlnConfigStruct,
    UlnConfigStructOutput,
} from 'src/contracts/ReceiveULN302';
import { AmbPayload } from 'src/store/types/store.types';
import { LayerZeroEnpointV2__factory } from 'src/contracts';
import { Resolver, loadResolver } from 'src/resolvers/resolver';
import { ParsePayload } from 'src/payload/decode.payload';
import { LayerZeroEnpointV2Interface, PacketSentEvent } from 'src/contracts/LayerZeroEnpointV2';

interface LayerZeroWorkerDataWithMapping extends LayerZeroWorkerData {
    layerZeroChainIdMap: Record<string, string>;
}

class LayerZeroWorker {
    private readonly config: LayerZeroWorkerDataWithMapping;
    private readonly chainId: string;
    private readonly store: Store;
    private readonly provider: JsonRpcProvider;
    private readonly logger: pino.Logger;
    private readonly bridgeAddress: string;
    private readonly layerZeroEnpointV2Interface: LayerZeroEnpointV2Interface;
    private readonly receiveULN302: ReceiveULN302;
    private readonly receiveULN302Interface: ReceiveULN302Interface;
    private readonly receiverAddress: string;
    private readonly resolver: Resolver;
    private readonly filterTopics: string[][];
    private readonly layerZeroChainIdMap: Record<string, string>;
    private readonly incentivesAddresses: Record<string, string>;
    private currentStatus: MonitorStatus | null = null;
    private monitor: MonitorInterface;

    constructor() {
        this.config = workerData as LayerZeroWorkerDataWithMapping;
        this.chainId = this.config.chainId;
        this.layerZeroChainIdMap = this.config.layerZeroChainIdMap;
        this.incentivesAddresses = this.config.incentivesAddresses;
        this.store = new Store(this.chainId);
        this.provider = this.initializeProvider(this.config.rpc);
        this.logger = this.initializeLogger(this.chainId);
        this.receiveULN302 = ReceiveULN302__factory.connect(
            this.config.receiverAddress,
            this.provider,
        );
        this.receiveULN302Interface = ReceiveULN302__factory.createInterface();
        this.bridgeAddress = this.config.bridgeAddress;
        this.receiverAddress = this.config.receiverAddress;
        this.layerZeroEnpointV2Interface =
            LayerZeroEnpointV2__factory.createInterface();
        this.resolver = this.loadResolver(
            this.config.resolver,
            this.provider,
            this.logger,
        );
        this.filterTopics = [
            [this.layerZeroEnpointV2Interface.getEvent('PacketSent').topicHash,
            this.receiveULN302Interface.getEvent('PayloadVerified').topicHash,]
        ];
        this.monitor = this.startListeningToMonitor(this.config.monitorPort);
    }

    // Initialization helpers
    // ********************************************************************************************

    /**
     * Initializes the logger with a specific chain ID.
     * 
     * @param chainId - The chain ID for which to initialize the logger.
     * @returns A pino logger instance.
     */
    private initializeLogger(chainId: string): pino.Logger {
        return pino(this.config.loggerOptions).child({
            worker: 'collector-layerzero',
            chain: chainId,
        });
    }

    /**
     * Initializes the provider with a specific RPC URL.
     * 
     * @param rpc - The RPC URL to use for the provider.
     * @returns A JsonRpcProvider instance.
     */
    private initializeProvider(rpc: string): JsonRpcProvider {
        return new JsonRpcProvider(rpc, undefined, { staticNetwork: true });
    }

    /**
     * Loads the resolver with a specific configuration.
     * 
     * @param resolver - The resolver configuration.
     * @param provider - The provider to use for the resolver.
     * @param logger - The logger to use for the resolver.
     * @returns A Resolver instance.
     */
    private loadResolver(
        resolver: string | null,
        provider: JsonRpcProvider,
        logger: pino.Logger,
    ): Resolver {
        return loadResolver(resolver, provider, logger);
    }

    /**
     * Starts listening to the monitor.
     * 
     * @param port - The message port for the monitor.
     * @returns A MonitorInterface instance.
     */
    private startListeningToMonitor(port: MessagePort): MonitorInterface {
        const monitor = new MonitorInterface(port);
        monitor.addListener((status: MonitorStatus) => {
            this.currentStatus = status;
        });
        return monitor;
    }

    // Main handler
    // ********************************************************************************************

    /**
     * Main function to run the Layer Zero worker.
     */
    async run(): Promise<void> {
        this.logger.info(
            {
                bridgeAddress: this.config.bridgeAddress,
                receiverAddress: this.config.receiverAddress,
            },
            `LayerZero collector worker started.`,
        );
        let fromBlock = null;
        while (fromBlock == null) {
            if (this.currentStatus != null) {
                if (this.config.startingBlock != null) {
                    if (this.config.startingBlock < 0) {
                        fromBlock = this.currentStatus.blockNumber + this.config.startingBlock;
                        if (fromBlock < 0) {
                            throw new Error(`Invalid 'startingBlock': negative offset is larger than the current block number.`)
                        }
                    } else {
                        fromBlock = this.config.startingBlock;
                    }
                } else {
                    fromBlock = this.currentStatus.blockNumber;
                }
            }
            await wait(this.config.processingInterval);
        }
        const stopBlock = this.config.stoppingBlock ?? Infinity;
        while (true) {
            try {
                let toBlock = this.currentStatus?.blockNumber;
                if (!toBlock || fromBlock > toBlock) {
                    await wait(this.config.processingInterval);
                    continue;
                }
                if (toBlock > stopBlock) {
                    toBlock = stopBlock;
                }
                const blocksToProcess = toBlock - fromBlock;
                if (
                    this.config.maxBlocks != null &&
                    blocksToProcess > this.config.maxBlocks
                ) {
                    toBlock = fromBlock + this.config.maxBlocks;
                }
                await this.queryAndProcessEvents(fromBlock, toBlock);
                this.logger.info(
                    { fromBlock, toBlock },
                    `Scanning LayerZero events.`,
                );
                if (toBlock >= stopBlock) {
                    this.logger.info(
                        { stopBlock: toBlock },
                        `Finished processing blocks: stopBlock reached.`,
                    );
                    break;
                }
                fromBlock = toBlock + 1;
            } catch (error) {
                this.logger.error(error, `Error on Layer Zero worker: processing blocks.`);
                await wait(this.config.retryInterval);
            }
            await wait(this.config.processingInterval);
        }
        this.monitor.close();
        await this.store.quit();
    }

    /**
     * Queries and processes events between two blocks.
     * 
     * @param fromBlock - The starting block number.
     * @param toBlock - The ending block number.
     */
    private async queryAndProcessEvents(
        fromBlock: number,
        toBlock: number,
    ): Promise<void> {
        const logs = await this.queryLogs(fromBlock, toBlock);
        for (const log of logs) {
            try {
                await this.handleEvent(log);
            } catch (error) {
                this.logger.error(
                    { log, error: tryErrorToString(error) },
                    `Failed to process event on layer-zero collector worker.`,
                );
            }
        }
    }

    /**
     * Queries logs between two blocks.
     * 
     * @param fromBlock - The starting block number.
     * @param toBlock - The ending block number.
     * @returns A list of logs.
     */
    private async queryLogs(fromBlock: number, toBlock: number): Promise<Log[]> {

        const filter = {
            address: [this.bridgeAddress, this.receiverAddress],
            fromBlock,
            toBlock,
            topics: this.filterTopics,
        };

        let logs: Log[] | undefined;
        let i = 0;
        while (logs == undefined) {
            try {
                logs = await this.provider.getLogs(filter);
            } catch (error) {
                i++;
                this.logger.warn(
                    { ...filter, error: tryErrorToString(error), try: i },
                    `Failed to 'getLogs' on layer-zero worker. Worker blocked until successful query.`
                );
                await wait(this.config.retryInterval);
            }
        }

        return logs;
    }

    // Event handlers
    // ********************************************************************************************

    /**
     * Handles events from logs.
     * 
     * @param log - The log data.
     */
    private async handleEvent(log: Log): Promise<void> {
        let parsedLog: LogDescription | null = null;
        if (log.address.toLowerCase() === this.bridgeAddress) {
            parsedLog = this.layerZeroEnpointV2Interface.parseLog(log);
        } else if (log.address.toLowerCase() === this.receiverAddress) {
            parsedLog = this.receiveULN302Interface.parseLog(log);
        }
        if (parsedLog == null) {
            this.logger.error(
                { topics: log.topics, data: log.data },
                `Failed to parse LayerZero event.`,
            );
            return;
        }

        switch (parsedLog.name) {
            case 'PacketSent':
                await this.handlePacketSentEvent(log, parsedLog);
                break;

            case 'PayloadVerified':
                await this.handlePayloadVerifiedEvent(log, parsedLog);
                break;

            default:
                this.logger.warn(
                    { name: parsedLog.name, topic: parsedLog.topic },
                    `Event with unknown name/topic received.`,
                );
        }
    }

    /**
     * Handles PacketSent events.
     * 
     * @param log - The log data.
     * @param parsedLog - The parsed log description.
     */
    private async handlePacketSentEvent(
        log: Log,
        parsedLog: LogDescription,
    ): Promise<void> {
        try {
            const {
                encodedPayload,
                options,
                sendLibrary
            } = parsedLog.args as unknown as PacketSentEvent.OutputObject;
            const packet = this.decodePacket(encodedPayload);
            const srcEidMapped = this.layerZeroChainIdMap[packet.srcEid];
            const dstEidMapped = this.layerZeroChainIdMap[packet.dstEid];

            this.logger.debug(
                { transactionHash: log.transactionHash, packet, options, sendLibrary },
                'PacketSent event found.',
            );

            if (srcEidMapped === undefined || dstEidMapped === undefined) {
                this.logger.debug(
                    {
                        transactionHash: log.transactionHash,
                        packet,
                        options,
                        sendLibrary,
                    },
                    'Skipping packet: unsupported srcEid/dstEid.',
                );
                return;
            }

            const decodedMessage = ParsePayload(packet.message);
            if (decodedMessage === undefined) {
                throw new Error('Failed to decode message payload.');
            }
            if (
                paddedTo0xAddress(packet.sender).toLowerCase() ===
                this.incentivesAddresses[srcEidMapped]
            ) {
                this.logger.info(
                    { sender: packet.sender, message: packet.message },
                    'Processing packet from specific sender: sender and message details.',
                );
                const transactionBlockNumber =
                    await this.resolver.getTransactionBlockNumber(log.blockNumber);
                await this.store.setAmb(
                    {
                        messageIdentifier: decodedMessage.messageIdentifier,
                        amb: 'layer-zero',
                        sourceChain: srcEidMapped.toString(),
                        destinationChain: dstEidMapped.toString(),
                        sourceEscrow: packet.sender,
                        payload: decodedMessage.message,
                        recoveryContext: '0x',
                        blockNumber: log.blockNumber,
                        transactionBlockNumber,
                        blockHash: log.blockHash,
                        transactionHash: log.transactionHash,
                    },
                    log.transactionHash,
                );

                const payloadHash = this.calculatePayloadHash(
                    packet.guid,
                    packet.message,
                );

                await this.store.setPayload('layer-zero', 'ambMessage', payloadHash, {
                    messageIdentifier: decodedMessage.messageIdentifier,
                    destinationChain: dstEidMapped,
                    payload: encodedPayload,
                });

                this.logger.info(
                    {
                        messageIdentifier: decodedMessage.messageIdentifier,
                        transactionHash: log.transactionHash,
                        payloadHash
                    },
                    'Collected message.',
                );
            } else {
                this.logger.debug(
                    { sender: packet.sender },
                    'Skipping packet: sender is not a GARP contract.',
                );
            }
        } catch (error) {
            this.logger.error({ error: tryErrorToString(error), log }, 'Failed to handle PacketSent event.');
        }
    }

    /**
     * Handles PayloadVerified events.
     * 
     * @param _log - The log data.
     * @param parsedLog - The parsed log description.
     */
    private async handlePayloadVerifiedEvent(
        _log: Log,
        parsedLog: LogDescription,
    ): Promise<void> {
        const { dvn, header, confirmations, proofHash } = parsedLog.args as any;
        const decodedHeader = this.decodeHeader(header);
        const srcEidMapped = this.layerZeroChainIdMap[decodedHeader.srcEid];
        const dstEidMapped = this.layerZeroChainIdMap[decodedHeader.dstEid];
        if (srcEidMapped === undefined || dstEidMapped === undefined) {
            this.logger.error(
                {
                    srcEid: decodedHeader.srcEid,
                    dstEid: decodedHeader.dstEid
                },
                'Failed to map srcEidMapped or dstEidMapped.',
            );
            return;
        }
        if (
            decodedHeader.sender.toLowerCase() ===
            this.incentivesAddresses[srcEidMapped]
        ) {
            this.logger.info(
                { dvn, decodedHeader, confirmations, proofHash },
                'PayloadVerified event decoded.',
            );
            const payloadData = await this.store.getPayload('layer-zero', 'ambMessage', proofHash);
            if (!payloadData) {
                this.logger.error(
                    { proofHash },
                    'No data found in database for the given payloadHash: proofHash details.',
                );
                return;
            }
            try {
                const config = await getConfigData(
                    this.receiveULN302,
                    dvn,
                    decodedHeader.dstEid,
                );
                const isVerifiable = await checkIfVerifiable(
                    this.receiveULN302,
                    config,
                    keccak256(header),
                    proofHash,
                );
                if (isVerifiable) {
                    const ambPayload: AmbPayload = {
                        messageIdentifier: '0x' + payloadData.messageIdentifier,
                        amb: 'layer-zero',
                        destinationChainId: dstEidMapped.toString(),
                        message: payloadData.payload,
                        messageCtx: '0x',
                    };
                    this.logger.info({ proofHash }, `LayerZero proof found.`);
                    await this.store.submitProof(
                        this.layerZeroChainIdMap[decodedHeader.dstEid]!,
                        ambPayload,
                    );
                } else {
                    this.logger.debug('Payload could not be verified');
                }
            } catch (error) {
                this.logger.error(
                    { error: tryErrorToString(error) },
                    'Error during payload verification.',
                );
            }
        }
    }

    // Helper function to decode the packet data
    private decodePacket(encodedPacket: string): any {
        return {
            nonce: encodedPacket.slice(2 + 2, 2 + 2 + 16),
            srcEid: Number('0x' + encodedPacket.slice(20, 28)),
            sender: encodedPacket.slice(2 + 26, 2 + 26 + 64),
            dstEid: Number('0x' + encodedPacket.slice(2 + 90, 2 + 98)),
            receiver: encodedPacket.slice(2 + 98, 2 + 98 + 64),
            guid: encodedPacket.slice(2 + 162, 2 + 162 + 64),
            message: encodedPacket.slice(2 + 226),
        };
    }

    /**
     * Decodes the header of a payload.
     * This function extracts specific fields from the encoded header string, converting
     * hexadecimal values to appropriate formats, and returns an object containing these values.
     * The function ensures proper handling and formatting of Ethereum addresses and numeric IDs.
     * The first 2 bytes of the encoded header are skipped as they represent the version, later 
     * instead of using a counter to skip bytes, the slice function is used to extract the required.
     * 
     * @param encodedHeader - The encoded header string to be decoded.
     * @returns An object containing the decoded header fields.
     */
    private decodeHeader(encodedHeader: string): any {
        const version = encodedHeader.slice(2, 2 + 2);
        const nonce = encodedHeader.slice(2 + 2, 2 + 2 + 16);
        const srcEid = Number('0x' + encodedHeader.slice(2 + 18, 2 + 18 + 8));
        const sender = '0x' + encodedHeader.slice(2 + 26, 2 + 26 + 64).slice(24);
        const dstEid = Number('0x' + encodedHeader.slice(2 + 90, 2 + 90 + 8));
        const receiver = '0x' + encodedHeader.slice(2 + 98, 2 + 98 + 64).slice(24);

        return {
            version,
            nonce: Number('0x' + nonce),
            srcEid,
            sender,
            dstEid,
            receiver,
        };
    }


    private calculatePayloadHash(guid: string, message: string): string {
        const payload = `0x${guid}${message}`;
        return ethers.keccak256(payload);
    }
}

/**
     * Checks if the configuration is verifiable.
     * 
     * @param receiveULN302 - The ULN302 contract instance.
     * @param config - The ULN configuration.
     * @param headerHash - The header hash.
     * @param payloadHash - The payload hash.
     * @returns A boolean indicating if the configuration is verifiable.
     */
async function checkIfVerifiable(
    receiveULN302: ReceiveULN302,
    config: UlnConfigStruct,
    headerHash: BytesLike,
    payloadHash: BytesLike,
): Promise<boolean> {
    try {
        const requiredDVNs = config.requiredDVNs.map(dvn => dvn.toString());
        const optionalDVNs = config.optionalDVNs.map(dvn => dvn.toString());
        const formatConfig: UlnConfigStruct = {
            confirmations: '0x' + config.confirmations.toString(16).padStart(16, '0'),
            requiredDVNCount:
                '0x' + config.requiredDVNCount.toString(16).padStart(2, '0'),
            optionalDVNCount:
                '0x' + config.optionalDVNCount.toString(16).padStart(2, '0'),
            optionalDVNThreshold:
                '0x' + config.optionalDVNThreshold.toString(16).padStart(2, '0'),
            requiredDVNs: requiredDVNs,
            optionalDVNs: optionalDVNs,
        };
        const isVerifiable = await receiveULN302.verifiable(
            formatConfig,
            headerHash,
            payloadHash,
        );
        return isVerifiable;
    } catch (error) {
        throw new Error('Error verifying the payload.');
    }
}

/**
     * Retrieves the ULN configuration data.
     * 
     * @param receiveULN302 - The ULN302 contract instance.
     * @param dvn - The DVN.
     * @param remoteEid - The remote EID.
     * @returns The ULN configuration data.
     */
async function getConfigData(
    receiveULN302: ReceiveULN302,
    dvn: string,
    remoteEid: BigNumberish,
): Promise<UlnConfigStructOutput> {
    try {
        const config = await receiveULN302.getUlnConfig(
            dvn,
            '0x' + remoteEid.toString(16).padStart(8, '0'),
        );
        return config;
    } catch (error) {
        throw new Error('Error fetching configuration data: error details.');
    }
}

void new LayerZeroWorker().run();