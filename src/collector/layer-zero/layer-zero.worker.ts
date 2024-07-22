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
    keccak256,
} from 'ethers6';
import { Store } from '../../store/store.lib';
import { LayerZeroWorkerData } from './layer-zero';
import {
    MonitorInterface,
    MonitorStatus,
} from '../../monitor/monitor.interface';
import { ReceiveULN302__factory } from 'src/contracts/factories/ReceiveULN302__factory';
import { wait, tryErrorToString, defaultAbiCoder, getDestinationImplementation } from 'src/common/utils';
import {
    PayloadVerifiedEvent,
    ReceiveULN302,
    ReceiveULN302Interface,
    UlnConfigStruct,
} from 'src/contracts/ReceiveULN302';
import { AMBMessage, AMBProof } from 'src/store/store.types';
import { IncentivizedMessageEscrow, IncentivizedMessageEscrow__factory, LayerZeroEnpointV2__factory } from 'src/contracts';
import { Resolver, loadResolver } from 'src/resolvers/resolver';
import { ParsePayload } from 'src/payload/decode.payload';
import { LayerZeroEnpointV2Interface, PacketSentEvent } from 'src/contracts/LayerZeroEnpointV2';
import { STATUS_LOG_INTERVAL } from 'src/logger/logger.service';
import { calculatePayloadHash, decodeHeader, decodePacket } from './layer-zero.utils';

const ON_PACKET_SENT_PROCESSED_CHANNEL = 'packet_sent_processed';
const ON_PACKET_SENT_PROCESSED_DELAY = 30 * 1000;
const MAX_PENDING_PAYLOAD_VERIFIED_EVENT_DURATION = 6 * 60 * 60 * 1000;

interface LayerZeroPayloadData {
    messageIdentifier: string,
    payload: string,
}

interface PayloadVerifiedEvent {
    timestamp: number,
    payloadHash: string,
    log: Log,
}

class LayerZeroWorker {
    private readonly config: LayerZeroWorkerData;

    private readonly chainId: string;

    private readonly store: Store;
    private readonly resolver: Resolver;
    private readonly provider: JsonRpcProvider;
    private readonly logger: pino.Logger;

    private readonly messageEscrowContract: IncentivizedMessageEscrow;
    private readonly destinationImplementationCache: Record<string, Record<string, string>> = {};   // Map fromApplication + toChainId => destinationImplementation

    private readonly bridgeAddress: string;
    private readonly receiverAddress: string;
    private readonly layerZeroEnpointV2Interface: LayerZeroEnpointV2Interface;
    private readonly receiveULN302Interface: ReceiveULN302Interface;
    private readonly receiveULN302: ReceiveULN302;

    private readonly filterTopics: string[][];
    private readonly layerZeroChainIdMap: Record<string, string>;
    private readonly incentivesAddresses: Record<string, string>;

    // Keep track of unprocessed PayloadVerified events caused by not having processed yet the
    // corresponding PacketSent event on the source chain. This is most relevant for when
    // recovering past relays.
    private readonly pendingPayloadVerifiedEvents: PayloadVerifiedEvent[] = [];

    private currentStatus: MonitorStatus | null = null;
    private monitor: MonitorInterface;

    private fromBlock: number = 0;


    constructor() {
        this.config = workerData as LayerZeroWorkerData;

        this.chainId = this.config.chainId;
        this.store = new Store();
        this.provider = this.initializeProvider(this.config.rpc);
        this.logger = this.initializeLogger(this.chainId);
        this.resolver = this.loadResolver(
            this.config.resolver,
            this.provider,
            this.logger,
        );

        this.bridgeAddress = this.config.bridgeAddress;
        this.receiverAddress = this.config.receiverAddress;
        this.layerZeroEnpointV2Interface = LayerZeroEnpointV2__factory.createInterface();
        this.receiveULN302Interface = ReceiveULN302__factory.createInterface();
        this.receiveULN302 = ReceiveULN302__factory.connect(
            this.config.receiverAddress,
            this.provider,
        );

        this.filterTopics = [[
            this.layerZeroEnpointV2Interface.getEvent('PacketSent').topicHash,
            this.receiveULN302Interface.getEvent('PayloadVerified').topicHash,
        ]];
        this.layerZeroChainIdMap = this.config.layerZeroChainIdMap;
        this.incentivesAddresses = this.config.incentivesAddresses;

        this.messageEscrowContract = this.initializeMessageEscrowContract(
            this.config.incentivesAddress,
            this.provider,
        );

        this.monitor = this.startListeningToMonitor(this.config.monitorPort);

        this.initiateIntervalStatusLog();
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

    private initializeMessageEscrowContract(
        incentivesAddress: string,
        provider: JsonRpcProvider,
    ): IncentivizedMessageEscrow {
        return IncentivizedMessageEscrow__factory.connect(
            incentivesAddress,
            provider,
        );
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

        await this.listenForProcessedPackets();

        this.fromBlock = await this.getStartingBlock();
        const stopBlock = this.config.stoppingBlock ?? Infinity;

        while (true) {
            try {
                let toBlock = this.currentStatus?.blockNumber;
                if (!toBlock || this.fromBlock > toBlock) {
                    await wait(this.config.processingInterval);
                    continue;
                }
                if (toBlock > stopBlock) {
                    toBlock = stopBlock;
                }
                const blocksToProcess = toBlock - this.fromBlock;
                if (
                    this.config.maxBlocks != null &&
                    blocksToProcess > this.config.maxBlocks
                ) {
                    toBlock = this.fromBlock + this.config.maxBlocks;
                }
                await this.queryAndProcessEvents(this.fromBlock, toBlock);
                this.logger.debug(
                    { fromBlock: this.fromBlock, toBlock },
                    `Scanning LayerZero events.`,
                );
                if (toBlock >= stopBlock) {
                    this.logger.info(
                        { stopBlock: toBlock },
                        `Finished processing blocks: stopBlock reached.`,
                    );
                    break;
                }
                this.fromBlock = toBlock + 1;
            } catch (error) {
                this.logger.error(error, `Error on Layer Zero worker: processing blocks.`);
                await wait(this.config.retryInterval);
            }
            await wait(this.config.processingInterval);
        }
        this.monitor.close();
        await this.store.quit();
    }

    private async getStartingBlock(): Promise<number> {
        let fromBlock: number | null = null;
        while (fromBlock == null) {

            // Do not initialize 'fromBlock' whilst 'currentStatus' is null, even if
            // 'startingBlock' is specified.
            if (this.currentStatus == null) {
                await wait(this.config.processingInterval);
                continue;
            }

            if (this.config.startingBlock == null) {
                fromBlock = this.currentStatus.blockNumber;
                break;
            }

            if (this.config.startingBlock < 0) {
                fromBlock = this.currentStatus.blockNumber + this.config.startingBlock;
                if (fromBlock < 0) {
                    throw new Error(`Invalid 'startingBlock': negative offset is larger than the current block number.`)
                }
            } else {
                fromBlock = this.config.startingBlock;
            }
        }

        return fromBlock;
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

    private async listenForProcessedPackets(): Promise<void> {
        // Listen for whenever a packet is registered.
        await this.store.on(
            this.getOnPacketSentChannel(),
            (payloadHash: string) => {
                // Add a delay to prevent this handler from being executed at the exact same time
                // as the `handlePayloadVerifiedEvent()` handler, which can cause this handler to
                // search for a pending PayloadVerified event before it's registered.
                setTimeout(
                    () => void this.onProcessedPacketHandler(payloadHash),
                    ON_PACKET_SENT_PROCESSED_DELAY
                );
            }
        )
    }

    private async onProcessedPacketHandler(
        payloadHash: string
    ): Promise<void> {

        this.logger.debug(
            { payloadHash },
            `On PacketSent event recovery handler triggered.`
        );

        const pendingPayloadVerifiedEventIndex = this.pendingPayloadVerifiedEvents.findIndex(
            (event) => event.payloadHash === payloadHash,
        );

        if (pendingPayloadVerifiedEventIndex == -1) {
            return;
        }

        this.logger.info(
            { payloadHash },
            `Recovering PayloadVerified event.`
        );

        const [pendingEvent] = this.pendingPayloadVerifiedEvents.splice(pendingPayloadVerifiedEventIndex, 1);

        const parsedLog = this.receiveULN302Interface.parseLog(pendingEvent!.log);

        try {
            await this.handlePayloadVerifiedEvent(
                pendingEvent!.log,
                parsedLog!          // The log has been previously parsed, `parsedLog` should never be null.
            );
        }
        catch (error) {
            this.logger.error(
                {
                    payloadHash,
                    error: tryErrorToString(error),
                },
                `Error on PayloadVerified event recovery.`
            );
        }
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
        const {
            encodedPayload
        } = parsedLog.args as unknown as PacketSentEvent.OutputObject;

        const packet = decodePacket(encodedPayload);
        const fromChainId = this.layerZeroChainIdMap[packet.srcEid];
        const toChainId = this.layerZeroChainIdMap[packet.dstEid];

        const payloadHash = calculatePayloadHash(
            packet.guid,
            packet.message,
        );

        this.logger.debug(
            {
                transactionHash: log.transactionHash,
                payloadHash,
            },
            'PacketSent event found.',
        );

        if (fromChainId === undefined || toChainId === undefined) {
            this.logger.debug(
                {
                    transactionHash: log.transactionHash,
                    srcEid: packet.srcEid,
                    dstEid: packet.dstEid,
                },
                'Skipping PacketSent event: unsupported srcEid/dstEid.',
            );
            return;
        }

        if (packet.sender !== this.incentivesAddresses[fromChainId]) {
            this.logger.debug(
                {
                    transactionHash: log.transactionHash,
                    sender: packet.sender
                },
                'Skipping PacketSent event: unsupported packet sender.',
            );
            return;
        }

        const decodedMessage = ParsePayload(packet.message);
        if (decodedMessage === undefined) {
            throw new Error('Failed to decode GeneralisedIncentives payload.');
        }

        const messageIdentifier = '0x' + decodedMessage.messageIdentifier;

        this.logger.info(
            {
                messageIdentifier,
                transactionHash: log.transactionHash,
                payloadHash,
            },
            'Collected message.',
        );

        const transactionBlockNumber = await this.resolver.getTransactionBlockNumber(log.blockNumber);
        

        const channelId = defaultAbiCoder.encode(
            ['uint256'],
            [packet.dstEid],
        );

        const toIncentivesAddress = await getDestinationImplementation(
            decodedMessage.sourceApplicationAddress,
            channelId,
            this.messageEscrowContract,
            this.destinationImplementationCache,
            this.logger,
            this.config.retryInterval
        );

        const ambMessage: AMBMessage = {
            messageIdentifier,

            amb: 'layer-zero',
            fromChainId,
            toChainId,
            fromIncentivesAddress: packet.sender,
            toIncentivesAddress,

            incentivesPayload: packet.message,

            transactionBlockNumber,

            blockNumber: log.blockNumber,
            blockHash: log.blockHash,
            transactionHash: log.transactionHash,
        }

        await this.store.setAMBMessage(
            this.chainId,
            ambMessage,
        );

        await this.store.setAdditionalAMBData<LayerZeroPayloadData>(
            'layer-zero',
            payloadHash,
            {
                messageIdentifier,
                payload: encodedPayload
            },
        );

        // Broadcast that the PacketSent event has been processed to recover any pending logic
        // resulting from PayloadVerified events.
        await this.store.postMessage(
            this.getOnPacketSentChannel(),
            payloadHash
        );
    }

    /**
     * Handles PayloadVerified events.
     * 
     * ! A PayloadVerified event is emitted every time a specific packet is verified, but a single
     * ! event may not be enough to indicate that the packet is valid. Thus, there may be multiple
     * ! events for a single packet, which, depending at the time at which they are processed, can
     * ! result in this function submitting the proof for the same packet multiple times. This
     * ! undesired side effect is mitigated by the Store's `setAMBProof()` function, which will not
     * ! register proofs for the same packet more than once.
     * 
     * @param log - The log data.
     * @param parsedLog - The parsed log description.
     */
    private async handlePayloadVerifiedEvent(
        log: Log,
        parsedLog: LogDescription,
    ): Promise<void> {
        const {
            dvn,
            header,
            proofHash: payloadHash
        } = parsedLog.args as unknown as PayloadVerifiedEvent.OutputObject;

        const decodedHeader = decodeHeader(header);
        const fromChainId = this.layerZeroChainIdMap[decodedHeader.srcEid];
        const toChainId = this.layerZeroChainIdMap[decodedHeader.dstEid];

        this.logger.debug(
            {
                transactionHash: log.transactionHash,
                payloadHash,
            },
            'PayloadVerified event found.',
        );

        if (fromChainId === undefined || toChainId === undefined) {
            this.logger.debug(
                {
                    transactionHash: log.transactionHash,
                    srcEid: decodedHeader.srcEid,
                    dstEid: decodedHeader.dstEid
                },
                'Skipping PayloadVerified event: unsupported srcEid/dstEid.',
            );
            return;
        }

        if (decodedHeader.sender !== this.incentivesAddresses[fromChainId]) {
            this.logger.debug(
                {
                    transactionHash: log.transactionHash,
                    payloadHash,
                    sender: decodedHeader.sender
                },
                'Skipping PayloadVerified event: unsupported packet sender.',
            );
            return;
        }

        // Recover the encoded payload data from storage (saved on an earlier PacketSent event).
        const payloadData = await this.store.getAdditionalAMBData<LayerZeroPayloadData>(
            'layer-zero',
            payloadHash.toLowerCase()
        );
        if (!payloadData) {
            this.logger.info(
                { payloadHash },
                'No payload data found for the given payloadHash. Queueing for recovery for when the payload is available.',
            );

            this.queuePendingPayloadVerifiedEvent(
                payloadHash,
                log,
            );

            return;
        }

        const config = await this.getConfigData(
            dvn,
            decodedHeader.dstEid,
        );

        const isVerifiable = await this.checkIfVerifiable(
            config,
            keccak256(header),
            payloadHash,
        );

        if (isVerifiable) {
            const ambProof: AMBProof = {
                messageIdentifier: payloadData.messageIdentifier,

                amb: 'layer-zero',
                fromChainId,
                toChainId,

                message: payloadData.payload,
                messageCtx: '0x',
            };

            this.logger.info(
                {
                    messageIdentifier: payloadData.messageIdentifier,
                    payloadHash,
                },
                `LayerZero proof found.`
            );

            await this.store.setAMBProof(
                this.layerZeroChainIdMap[decodedHeader.dstEid]!,
                ambProof,
            );
        } else {
            this.logger.debug(
                {
                    messageIdentifier: payloadData.messageIdentifier,
                    payloadHash,
                },
                'Payload has not been verified yet.'
            );
        }
    }

    private queuePendingPayloadVerifiedEvent(
        payloadHash: string,
        log: Log,
    ): void {
        // Prune any old pending events (note that events are stored in chronological order).
        const pruneTimestamp = Date.now() - MAX_PENDING_PAYLOAD_VERIFIED_EVENT_DURATION;

        let firstNonStaleIndex;
        for (
            firstNonStaleIndex = 0;
            firstNonStaleIndex < this.pendingPayloadVerifiedEvents.length;
            firstNonStaleIndex++
        ) {
            if (this.pendingPayloadVerifiedEvents[firstNonStaleIndex]!.timestamp > pruneTimestamp) {
                break;
            }
        }

        if (firstNonStaleIndex != 0) {
            this.pendingPayloadVerifiedEvents.splice(0, firstNonStaleIndex);
        }


        // Register the pending event if not already pending, otherwise update the pending's event
        // 'timestamp'.
        const alreadyPendingEvent = this.pendingPayloadVerifiedEvents.find((event) => {
            event.payloadHash === payloadHash
        });

        if (alreadyPendingEvent != undefined) {
            alreadyPendingEvent.timestamp = Date.now();
        }
        else {
            this.pendingPayloadVerifiedEvents.push({
                timestamp: Date.now(),
                payloadHash,
                log,
            });
        }
    }
    

    async checkIfVerifiable(
        config: UlnConfigStruct,
        headerHash: BytesLike,
        payloadHash: BytesLike,
        maxTries: number = 3,
    ): Promise<boolean> {

        for (let tryCount = 0; tryCount < maxTries; tryCount++) {
            try {
                const isVerifiable = await this.receiveULN302.verifiable(
                    config,
                    headerHash,
                    payloadHash,
                );
                return isVerifiable;
            } catch (error) {
                this.logger.warn(
                    {
                        config,
                        headerHash,
                        payloadHash,
                        try: tryCount + 1,
                    },
                    `Failed to check the verifiable status of the given payload. Retrying if possible.`
                );
            }

            await wait(this.config.retryInterval);
        }

        throw new Error(`Failed to check verifiable status of the given payload (payload hash: ${payloadHash}).`);
    }

    //TODO can this be cached?
    async getConfigData(
        dvn: string,
        dstEid: number,
        maxTries: number = 3,
    ): Promise<UlnConfigStruct> {

        for (let tryCount = 0; tryCount < maxTries; tryCount++) {
            try {
                const config = await this.receiveULN302.getUlnConfig(
                    dvn,
                    dstEid,
                );

                return {
                    confirmations: config.confirmations,
                    requiredDVNCount: config.requiredDVNCount,
                    optionalDVNCount: config.optionalDVNCount,
                    optionalDVNThreshold: config.optionalDVNThreshold,
                    requiredDVNs: config.requiredDVNs.map(dvn => dvn.toString()),
                    optionalDVNs: config.optionalDVNs.map(dvn => dvn.toString()),
                };
            } catch (error) {
                this.logger.warn(
                    {
                        dvn,
                        dstEid,
                        try: tryCount + 1,
                    },
                    `Failed to query the ULN configuration. Retrying if possible.`
                );
            }

            await wait(this.config.retryInterval);
        }

        throw new Error(`Failed to query the ULN configuration. (dvn: ${dvn}, destination eid: ${dstEid}).`);
    }

    private getOnPacketSentChannel(): string {
        return Store.getChannel('layer-zero', ON_PACKET_SENT_PROCESSED_CHANNEL);
    }


    // Misc Helpers
    // ********************************************************************************************

    private initiateIntervalStatusLog(): void {
        const logStatus = () => {
            this.logger.info(
                {
                    latestBlock: this.currentStatus?.blockNumber,
                    currentBlock: this.fromBlock,
                },
                'LayerZero collector status.'
            );
        };
        setInterval(logStatus, STATUS_LOG_INTERVAL);
    }
}

void new LayerZeroWorker().run();