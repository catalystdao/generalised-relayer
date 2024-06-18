import pino, { LoggerOptions } from 'pino';
import { workerData, MessagePort } from 'worker_threads';
import { JsonRpcProvider, Log, LogDescription, zeroPadValue, BytesLike, BigNumberish, keccak256, ethers } from 'ethers6';
import { Store } from '../../store/store.lib';
import { LayerZeroWorkerData } from './layerZero';
import { MonitorInterface, MonitorStatus } from '../../monitor/monitor.interface';
import { RecieveULN302__factory } from 'src/contracts/factories/RecieveULN302__factory';
import { wait, tryErrorToString, paddedToNormalAddress } from 'src/common/utils';
import { RecieveULN302, RecieveULN302Interface, UlnConfigStruct, UlnConfigStructOutput } from 'src/contracts/RecieveULN302';
import { AmbPayload } from 'src/store/types/store.types';
import { BigNumber } from 'ethers';
import { LayerZeroEnpointV2, LayerZeroEnpointV2__factory } from 'src/contracts';
import { Resolver, loadResolver } from 'src/resolvers/resolver';
import { ParsePayload } from 'src/payload/decode.payload';
import { LayerZeroEnpointV2Interface } from 'src/contracts/LayerZeroEnpointV2';

interface LayerZeroWorkerDataWithMapping extends LayerZeroWorkerData {
    layerZeroChainIdMap: Record<number, string>;
}

class CombinedWorker {
    private readonly config: LayerZeroWorkerDataWithMapping;
    private readonly chainId: string;
    private readonly store: Store;
    private readonly provider: JsonRpcProvider;
    private readonly logger: pino.Logger;
    private readonly bridgeAddress: string;
    private readonly filterTopics: string[][];
    private readonly layerZeroEnpointV2Interface: LayerZeroEnpointV2Interface;
    private readonly recieveULN302: RecieveULN302;
    private readonly recieveULN302Interface: RecieveULN302Interface;
    private readonly receiverAddress: string;
    private readonly resolver: Resolver;
    private readonly layerZeroChainIdMap: Record<number, string>;
    private currentStatus: MonitorStatus | null = null;
    private monitor: MonitorInterface;

    constructor() {
        this.config = workerData as LayerZeroWorkerDataWithMapping;
        this.chainId = this.config.chainId;
        this.layerZeroChainIdMap = this.config.layerZeroChainIdMap;
        this.store = new Store(this.chainId);
        this.provider = this.initializeProvider(this.config.rpc);
        this.logger = this.initializeLogger(this.chainId);
        this.recieveULN302 = RecieveULN302__factory.connect(this.config.receiverAddress, this.provider);
        this.recieveULN302Interface = RecieveULN302__factory.createInterface();
        this.bridgeAddress = this.config.bridgeAddress;
        this.receiverAddress = this.config.receiverAddress;
        this.layerZeroEnpointV2Interface = LayerZeroEnpointV2__factory.createInterface();
        this.filterTopics = [
            [
                this.layerZeroEnpointV2Interface.getEvent('PacketSent').topicHash,
                zeroPadValue(this.bridgeAddress, 32),
            ],
            [
                this.recieveULN302Interface.getEvent('PayloadVerified').topicHash,
                zeroPadValue(this.receiverAddress, 32),
            ]
        ];
        this.resolver = this.loadResolver(this.config.resolver, this.provider, this.logger);
        this.monitor = this.startListeningToMonitor(this.config.monitorPort);
    }

    // Initialization helpers
    // ********************************************************************************************

    private initializeLogger(chainId: string): pino.Logger {
        return pino(this.config.loggerOptions).child({
            worker: 'combined-layerzero-worker',
            chain: chainId,
        });
    }

    private initializeProvider(rpc: string): JsonRpcProvider {
        return new JsonRpcProvider(rpc, undefined, { staticNetwork: true });
    }

    private loadResolver(resolver: string | null, provider: JsonRpcProvider, logger: pino.Logger): Resolver {
        return loadResolver(resolver, provider, logger);
    }

    private startListeningToMonitor(port: MessagePort): MonitorInterface {
        const monitor = new MonitorInterface(port);
        monitor.addListener((status: MonitorStatus) => {
            this.currentStatus = status;
        });
        return monitor;
    }

    // Main handler
    // ********************************************************************************************

    async run(): Promise<void> {
        this.logger.info({ bridgeAddress: this.config.bridgeAddress }, `Combined Layer Zero Worker started.`);
        let fromBlock = null;
        while (fromBlock == null) {
            if (this.currentStatus != null) {
                fromBlock = this.config.startingBlock ?? this.currentStatus.blockNumber;
            } else {
                this.logger.info('Current status is still null.');
            }
            await wait(this.config.processingInterval);
        }
        this.logger.info('fromBlock initialized.');
        const stopBlock = this.config.stoppingBlock ?? Infinity;
        this.logger.info(`Stop block set to ${stopBlock}`);
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
                if (this.config.maxBlocks != null && blocksToProcess > this.config.maxBlocks) {
                    toBlock = fromBlock + this.config.maxBlocks;
                }
                this.logger.info({ fromBlock, toBlock }, `Scanning LayerZero Endpoint messages.`);
                await this.queryAndProcessEvents(fromBlock, toBlock);
                if (toBlock >= stopBlock) {
                    this.logger.info({ stopBlock: toBlock }, `Finished processing blocks. Exiting worker.`);
                    break;
                }
                fromBlock = toBlock + 1;
            } catch (error) {
                this.logger.error(error, `Error on Layer Zero worker`);
                await wait(this.config.retryInterval);
            }
            await wait(this.config.processingInterval);
        }
        this.monitor.close();
        await this.store.quit();
    }

    private async queryAndProcessEvents(fromBlock: number, toBlock: number): Promise<void> {
        const logs = await this.queryLogs(fromBlock, toBlock);
        for (const log of logs) {
            try {
                await this.handleEvent(log);
            } catch (error) {
                this.logger.error({ log, error }, `Failed to process event on getter worker.`);
            }
        }
    }

    private async queryLogs(fromBlock: number, toBlock: number): Promise<Log[]> {
        const filterPacketSent = {
            address: this.bridgeAddress,
            topics: this.filterTopics[0],
            fromBlock,
            toBlock
        };
        const filterPayloadVerified = {
            address: this.receiverAddress,
            topics: this.filterTopics[1],
            fromBlock,
            toBlock
        };
    
        let logsPacketSent: Log[] | undefined;
        let logsPayloadVerified: Log[] | undefined;
    
        let i = 0;
        while (logsPacketSent == undefined || logsPayloadVerified == undefined) {
            try {
                if (logsPacketSent == undefined) {
                    logsPacketSent = await this.provider.getLogs(filterPacketSent);
                }
                if (logsPayloadVerified == undefined) {
                    logsPayloadVerified = await this.provider.getLogs(filterPayloadVerified);
                }
            } catch (error) {
                i++;
                this.logger.warn(
                    { ...filterPacketSent, error: tryErrorToString(error), try: i },
                    `Failed to 'getLogs' for PacketSent. Worker blocked until successful query.`
                );
                this.logger.warn(
                    { ...filterPayloadVerified, error: tryErrorToString(error), try: i },
                    `Failed to 'getLogs' for PayloadVerified. Worker blocked until successful query.`
                );
                await wait(this.config.retryInterval);
            }
        }
    
        return (logsPacketSent ?? []).concat(logsPayloadVerified ?? []);
    }

    // Event handlers
    // ********************************************************************************************

    private async handleEvent(log: Log): Promise<void> {
        let parsedLog: LogDescription | null = null;

        if (log.address === this.bridgeAddress) {
            parsedLog = this.layerZeroEnpointV2Interface.parseLog(log);
        } else if (log.address === this.receiverAddress) {
            parsedLog = this.recieveULN302Interface.parseLog(log);
        }

        if (parsedLog == null) {
            this.logger.error(
                { topics: log.topics, data: log.data },
                `Failed to parse event.`,
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

    private async handlePacketSentEvent(log: Log, parsedLog: LogDescription): Promise<void> {
        const decodedLog = parsedLog.args;
        const encodedPacket = decodedLog['encodedPacket'];
        const options = decodedLog['options'];
        const sendLibrary = decodedLog['sendLibrary'];
        const packet = this.decodePacket(encodedPacket);
        const decodedMessage = ParsePayload(packet.message);

        if (decodedMessage === undefined) {
            throw new Error('Failed to decode message payload.');
        }

        this.logger.info(
            { transactionHash: log.transactionHash, packet, options, sendLibrary },
            'PacketSent event processed.',
        );

        if (paddedToNormalAddress(packet.sender) === this.config.incentivesAddress) {
            this.logger.info({ sender: packet.sender, message: packet.message }, 'Processing packet from specific sender.');
            const transactionBlockNumber = await this.resolver.getTransactionBlockNumber(log.blockNumber);
            await this.store.setAmb({
                messageIdentifier: decodedMessage.messageIdentifier,
                amb: 'layerZero',
                sourceChain: packet.srcEid,
                destinationChain: packet.dstEid,
                sourceEscrow: packet.sender,
                payload: decodedMessage.message,
                recoveryContext: '0x',
                blockNumber: log.blockNumber,
                transactionBlockNumber,
                blockHash: log.blockHash,
                transactionHash: log.transactionHash,
            }, log.transactionHash);
            const payloadHash = this.calculatePayloadHash(packet.guid, packet.message);
            await this.store.setPayloadLayerZeroAmb(payloadHash, {
                messageIdentifier: decodedMessage.messageIdentifier,
                destinationChain: packet.dstEid,
                payload: encodedPacket,
            });
            this.logger.info(
                { payloadHash, transactionHash: log.transactionHash },
                'Secondary AMB message created with payload hash as key using setPayloadLayerZeroAmb.',
            );
        }
    }

    private async handlePayloadVerifiedEvent(log: Log, parsedLog: LogDescription): Promise<void> {
        const { dvn, header, confirmations, proofHash } = parsedLog.args as any;
        const decodedHeader = this.decodeHeader(header);
        if (decodedHeader.sender.toLowerCase() === this.config.incentivesAddress.toLowerCase()) {
            this.logger.info({ dvn, decodedHeader, confirmations, proofHash }, 'PayloadVerified event decoded.');
            const payloadData = await this.store.getAmbByPayloadHash(proofHash);
            if (!payloadData) {
                this.logger.error({ proofHash }, 'No data found in database for the given payloadHash.');
                return;
            }
            this.logger.info({ payloadData }, 'Data fetched from database using payloadHash.');
            try {
                const config = await getConfigData(this.recieveULN302, dvn, decodedHeader.dstEid);
                const isVerifiable = await checkIfVerifiable(this.recieveULN302, config, keccak256(header), proofHash);
                this.logger.info({ dvn, isVerifiable }, 'Verification result checked.');
                if (isVerifiable) {
                    const ambPayload: AmbPayload = {
                        messageIdentifier: '0x' + payloadData.messageIdentifier,
                        amb: 'layerZero',
                        destinationChainId: decodedHeader.dstEid.toString(),
                        message: payloadData.payload,
                        messageCtx: '0x',
                    };
                    this.logger.info({ proofHash }, `LayerZero proof found.`);
                    await this.store.submitProof(this.layerZeroChainIdMap[decodedHeader.dstEid]!, ambPayload);
                }
            } catch (error) {
                this.logger.error({ error: tryErrorToString(error) }, 'Error during configuration verification.');
            }
        }
    }

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

    private decodeHeader(encodedHeader: string): any {
        const version = encodedHeader.slice(2, 2 + 2);
        const nonce = encodedHeader.slice(2 + 2, 2 + 2 + 16);
        const srcEid = encodedHeader.slice(2 + 2 + 16, 2 + 2 + 16 + 8);
        const sender = encodedHeader.slice(2 + 2 + 16 + 8, 2 + 2 + 16 + 8 + 64).slice(24);
        const dstEid = encodedHeader.slice(2 + 2 + 16 + 8 + 64, 2 + 2 + 16 + 8 + 64 + 8);
        const receiver = encodedHeader.slice(2 + 2 + 16 + 8 + 64 + 8, 2 + 2 + 16 + 8 + 64 + 8 + 64).slice(24);
        return {
            version,
            nonce: BigNumber.from('0x' + nonce).toNumber(),
            srcEid: BigNumber.from('0x' + srcEid).toNumber(),
            sender: '0x' + sender,
            dstEid: BigNumber.from('0x' + dstEid).toNumber(),
            receiver: '0x' + receiver,
        };
    }

    private calculatePayloadHash(guid: string, message: string): string {
        const payload = `0x${guid}${message}`;
        return ethers.keccak256(payload);
    }
}

async function checkIfVerifiable(recieveULN302: RecieveULN302, config: UlnConfigStruct, headerHash: BytesLike, payloadHash: BytesLike): Promise<boolean> {
    try {
        const formatConfig: UlnConfigStruct = {
            confirmations: '0x' + config.confirmations.toString(16).padStart(16, '0'),
            requiredDVNCount: '0x' + config.requiredDVNCount.toString(16).padStart(2, '0'),
            optionalDVNCount: '0x' + config.optionalDVNCount.toString(16).padStart(2, '0'),
            optionalDVNThreshold: '0x' + config.optionalDVNThreshold.toString(16).padStart(2, '0'),
            requiredDVNs: [config.requiredDVNs.toString()],
            optionalDVNs: [],
        };
        const isVerifiable = await recieveULN302.verifiable(formatConfig, headerHash, payloadHash);
        return isVerifiable;
    } catch (error) {
        console.error('Failed to verify the configuration: ', error);
        throw new Error('Error verifying the configuration.');
    }
}

async function getConfigData(recieveULN302: RecieveULN302, dvn: string, remoteEid: BigNumberish): Promise<UlnConfigStructOutput> {
    try {
        const config = await recieveULN302.getUlnConfig(dvn, '0x' + remoteEid.toString(16).padStart(8, '0'));
        return config;
    } catch (error) {
        throw new Error('Error fetching configuration data.');
    }
}

void new CombinedWorker().run();
