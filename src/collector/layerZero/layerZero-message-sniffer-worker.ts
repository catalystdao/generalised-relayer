import pino, { LoggerOptions } from 'pino';
import {
    LayerZeroEnpointV2,
    LayerZeroEnpointV2__factory,
} from 'src/contracts';
import { Store } from 'src/store/store.lib';
import { workerData, MessagePort } from 'worker_threads';
import { paddedToNormalAddress, tryErrorToString, wait } from '../../common/utils';
import { JsonRpcProvider, Log, ethers, zeroPadValue } from 'ethers6';
import { MonitorInterface, MonitorStatus } from 'src/monitor/monitor.interface';
import { Resolver, loadResolver } from 'src/resolvers/resolver';
import { LayerZeroWorkerData } from './layerZero';
import { LayerZeroEnpointV2Interface } from 'src/contracts/LayerZeroEnpointV2';
import { ParsePayload } from 'src/payload/decode.payload';
import { BigNumber } from 'ethers';


class SendMessageSnifferWorker {
  
    private readonly store: Store;
    private readonly logger: pino.Logger;
    private readonly endpointAddress: string;
    private readonly filterTopics: string[][];
    private readonly config: LayerZeroWorkerData;

    private readonly provider: JsonRpcProvider;

    private readonly chainId: string;
    private readonly layerZeroEnpointV2Interface: LayerZeroEnpointV2Interface;

    private readonly resolver: Resolver;

    private currentStatus: MonitorStatus | null = null;
    private monitor: MonitorInterface;

    constructor() {
        this.config = workerData as LayerZeroWorkerData;

        this.chainId = this.config.chainId;

        this.store = new Store(this.chainId);
        this.logger = this.initializeLogger(
            this.chainId,
            this.config.loggerOptions,
        );
        this.provider = this.initializeProvider(this.config.rpc);
        this.resolver = this.loadResolver(
            this.config.resolver,
            this.provider,
            this.logger,
        );

        this.endpointAddress = this.config.endpointAddress;
        this.layerZeroEnpointV2Interface = LayerZeroEnpointV2__factory.createInterface();
        this.filterTopics = [
            [
                this.layerZeroEnpointV2Interface.getEvent('PacketSent').topicHash,
                zeroPadValue(this.endpointAddress, 32),
            ],
        ];

        this.monitor = this.startListeningToMonitor(this.config.monitorPort);
    }

    // Initialization helpers
    // ********************************************************************************************

    private initializeLogger(
        chainId: string,
        loggerOptions: LoggerOptions,
    ): pino.Logger {
        return pino(loggerOptions).child({
            worker: 'collector-layerzero-message-sniffer',
            chain: chainId,
        });
    }

    private initializeProvider(rpc: string): JsonRpcProvider {
        return new JsonRpcProvider(rpc, undefined, { staticNetwork: true });
    }

    private loadResolver(
        resolver: string | null,
        provider: JsonRpcProvider,
        logger: pino.Logger,
    ): Resolver {
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
        this.logger.info(
            { endpointAddress: this.config.endpointAddress },
            `Layer Zero Message Sniffer Worker started.`,
        );

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
    
                this.logger.info(
                    {
                        fromBlock,
                        toBlock,
                    },
                    `Scanning LayerZero Endpoint messages.`,
                );
    
                await this.queryAndProcessEvents(fromBlock, toBlock);
              
    
                if (toBlock >= stopBlock) {
                    this.logger.info(
                        { stopBlock: toBlock },
                        `Finished processing blocks. Exiting worker.`,
                    );
                    break;
                }
    
                fromBlock = toBlock + 1;
            } catch (error) {
                this.logger.error(error, `Error on Layer Zero worker`);
                await wait(this.config.retryInterval);
            }
    
            await wait(this.config.processingInterval);
        }
    
        // Cleanup worker
        this.monitor.close();
        await this.store.quit();
    }

    private async queryAndProcessEvents(fromBlock: number, toBlock: number): Promise<void> {
        const logs = await this.queryLogs(fromBlock, toBlock);
        console.info(logs);
        for (const log of logs) {
            try {
                await this.handleLogPacketSentEvent(log);
            } catch (error) {
                this.logger.error(
                    { log, error },
                    'Failed to process LogPacketSentEvent on Layer Zero Message Sniffer Worker.',
                );
            }
        }
    }
    
    private async queryLogs(fromBlock: number, toBlock: number): Promise<Log[]> {
        const filter = {
            address: this.endpointAddress,
            topics: this.filterTopics,
            fromBlock,
            toBlock,
        };
        let logs: Log[] | undefined;
        let i = 0;
        while (logs === undefined) {
            try {
                logs = await this.provider.getLogs(filter);
            } catch (error) {
                i++;
                this.logger.warn(
                    { ...filter, error: tryErrorToString(error), try: i },
                    `Failed to 'getLogs' on Layer Zero Message Sniffer Worker. Worker blocked until successful query.`,
                );
                await wait(this.config.retryInterval);
            }
        }
        return logs;
    }
    
    

    private async handleLogPacketSentEvent(log: Log): Promise<void> {
        this.logger.info(`Processing log: ${JSON.stringify(log)}`);
        try {
            const decodedLog = new ethers.Interface([
                'event PacketSent(bytes encodedPacket, bytes options, address sendLibrary)',
            ]).parseLog(log);
    
            if (decodedLog !== null) {
                const encodedPacket = decodedLog.args['encodedPacket'];
                const options = decodedLog.args['options'];
                const sendLibrary = decodedLog.args['sendLibrary'];
    
                // Decode the packet details
                const packet = this.decodePacket(encodedPacket);
                const decodedMessage = ParsePayload(packet.message);
                if (decodedMessage === undefined) {
                    throw new Error('Failed to decode message payload.');
                }
    
                this.logger.info(
                    {
                        transactionHash: log.transactionHash,
                        packet,
                        options,
                        sendLibrary,
                    },
                    'PacketSent event processed.',
                );
    
                if (paddedToNormalAddress( packet.sender) === this.config.incentivesAddress) {
                    this.logger.info(
                        {
                            sender: packet.sender,
                            message: packet.message,
                        },
                        'Processing packet from specific sender.',
                    );
    
                    //
                    const transactionBlockNumber = await this.resolver.getTransactionBlockNumber(
                        log.blockNumber,
                    );
    
                    // Create the initial AMB message
                    await this.store.setAmb(
                        {
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
                        },
                        log.transactionHash,
                    );
    
                    // Calculate payload hash
                    const payloadHash = this.calculatePayloadHash(packet.guid, packet.message);
    
                    // Create the secondary AMB message using setPayloadLayerZeroAmb
                    await this.store.setPayloadLayerZeroAmb(
                        payloadHash,
                        {
                            messageIdentifier: decodedMessage.messageIdentifier,
                            destinationChain: packet.dstEid,
                            payload: encodedPacket,
                        }
                    );
    
                    this.logger.info(
                        {
                            payloadHash,
                            transactionHash: log.transactionHash,
                        },
                        'Secondary AMB message created with payload hash as key using setPayloadLayerZeroAmb.',
                    );
                }
            }
        } catch (error) {
            this.logger.error(
                {
                    error: tryErrorToString(error),
                    log,
                },
                'Error processing PacketSent event.',
            );
        }
    }
    
    
    private calculatePayloadHash(guid: string, message: string): string {
        const payload = `0x${guid}${message}`
        return ethers.keccak256(payload);
    }
    

    // Helper function to decode the packet data
    private decodePacket(encodedPacket: string): any {
        return {
            nonce: encodedPacket.slice(2+2,2+2+16),
            srcEid: BigNumber.from('0x' + encodedPacket.slice(20, 28)).toNumber(),
            sender: encodedPacket.slice(2+26, 2+26+64),
            dstEid: BigNumber.from('0x' + encodedPacket.slice(60, 68)).toNumber(),
            receiver: encodedPacket.slice(2+98, 2+98+64),
            guid: encodedPacket.slice(2+162, 2+162+64),
            message: encodedPacket.slice(2+226),
        };
    }
    /**
   * Decodes a message with context from a given encoded string.
   * 
   * @param {string} encodedMessage - The encoded message as a hex string.
   * @returns {GARPDecodedMessage} - The decoded message components.
   */
  
}

void new SendMessageSnifferWorker().run();
