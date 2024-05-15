import pino from 'pino';
import { tryErrorToString, wait } from 'src/common/utils';
import { IbcEventEmitter__factory } from 'src/contracts';
import { Store } from 'src/store/store.lib';
import { AmbMessage } from 'src/store/types/store.types';
import { workerData, MessagePort } from 'worker_threads';
import { PolymerWorkerData } from './polymer';
import { AbiCoder, JsonRpcProvider, Log, LogDescription, zeroPadValue } from 'ethers6';
import { IbcEventEmitterInterface, SendPacketEvent } from 'src/contracts/IbcEventEmitter';
import { MonitorInterface, MonitorStatus } from 'src/monitor/monitor.interface';
import { Resolver, loadResolver } from 'src/resolvers/resolver';

const abi = AbiCoder.defaultAbiCoder();

class PolymerCollectorSnifferWorker {

    private readonly config: PolymerWorkerData;

    private readonly chainId: string;

    private readonly incentivesAddress: string;
    private readonly polymerAddress: string;
    private readonly ibcEventEmitterInterface: IbcEventEmitterInterface;
    private readonly filterTopics: string[][];

    private readonly resolver: Resolver;
    private readonly store: Store;
    private readonly provider: JsonRpcProvider;
    private readonly logger: pino.Logger;

    private currentStatus: MonitorStatus | null = null;
    private monitor: MonitorInterface;


    constructor() {
        this.config = workerData as PolymerWorkerData;

        this.chainId = this.config.chainId;

        this.store = new Store(this.chainId);
        this.provider = this.initializeProvider(this.config.rpc);
        this.logger = this.initializeLogger(this.chainId);
        this.resolver = this.loadResolver(
            this.config.resolver,
            this.provider,
            this.logger
        );

        // Define the parameters for the rpc logs queries
        this.incentivesAddress = this.config.incentivesAddress;
        this.polymerAddress = this.config.polymerAddress;
        this.ibcEventEmitterInterface = IbcEventEmitter__factory.createInterface();
        this.filterTopics = [
            [this.ibcEventEmitterInterface.getEvent('SendPacket').topicHash, zeroPadValue(this.incentivesAddress, 32)]
        ];

        this.monitor = this.startListeningToMonitor(this.config.monitorPort);
    }



    // Initialization helpers
    // ********************************************************************************************

    private initializeLogger(chainId: string): pino.Logger {
        return pino(this.config.loggerOptions).child({
            worker: 'collector-polymer-sniffer',
            chain: chainId,
        });
    }

    private initializeProvider(rpc: string): JsonRpcProvider {
        return new JsonRpcProvider(
            rpc,
            undefined,
            { staticNetwork: true }
        )
    }

    private loadResolver(
        resolver: string | null,
        provider: JsonRpcProvider,
        logger: pino.Logger
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
            { incentiveAddresses: this.incentivesAddress },
            `Polymer collector sniffer worker started.`,
        );

        let fromBlock = null;
        while (fromBlock == null) {
            // Do not initialize 'fromBlock' whilst 'currentStatus' is null, even if
            // 'startingBlock' is specified.
            if (this.currentStatus != null) {
                fromBlock = (
                    this.config.startingBlock ?? this.currentStatus.blockNumber
                );
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
                if (this.config.maxBlocks != null && blocksToProcess > this.config.maxBlocks) {
                    toBlock = fromBlock + this.config.maxBlocks;
                }

                this.logger.info(
                    {
                        fromBlock,
                        toBlock,
                    },
                    `Scanning polymer messages.`,
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
            }
            catch (error) {
                this.logger.error(error, `Error on polymer.worker`);
                await wait(this.config.retryInterval)
            }

            await wait(this.config.processingInterval);
        }

        // Cleanup worker
        this.monitor.close();
        await this.store.quit();
    }

    private async queryAndProcessEvents(
        fromBlock: number,
        toBlock: number
    ): Promise<void> {

        const logs = await this.queryLogs(fromBlock, toBlock);

        for (const log of logs) {
            try {
                await this.handleEvent(log);
            } catch (error) {
                this.logger.error(
                    { log, error },
                    `Failed to process event on polymer collector sniffer worker.`
                );
            }
        }
    }

    private async queryLogs(
        fromBlock: number,
        toBlock: number
    ): Promise<Log[]> {
        const filter = {
            address: this.polymerAddress,
            topics: this.filterTopics,
            fromBlock,
            toBlock
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
                    `Failed to 'getLogs' on polymer collector sniffer. Worker blocked until successful query.`
                );
                await wait(this.config.retryInterval);
            }
        }

        return logs;
    }

    // Event handlers
    // ********************************************************************************************

    private async handleEvent(log: Log): Promise<void> {
        const parsedLog = this.ibcEventEmitterInterface.parseLog(log);

        if (parsedLog == null) {
            this.logger.error(
                { topics: log.topics, data: log.data },
                `Failed to parse a polymer contract event.`,
            );
            return;
        }

        if (parsedLog.name != 'SendPacket') {
            this.logger.warn(
                { name: parsedLog.name, topic: parsedLog.topic },
                `Event with unknown name/topic received.`,
            );
            return;
        }

        await this.handleSendPacketEvent(log, parsedLog);
    }

    private async handleSendPacketEvent(
        log: Log,
        parsedLog: LogDescription
    ): Promise<void> {

        const event = parsedLog.args as unknown as SendPacketEvent.OutputObject;

        // We need to convert the source channel id to the destination chain using the
        // settings map.
        const destinationChain: string | undefined = this.config.polymerChannels[event.sourceChannelId];
        if (destinationChain === undefined) {
            this.logger.debug(`DestinationChain: ${destinationChain} not found in config.`)
            return;
        }

        // Decode the Universal channel payload
        // Polymer has 32 bytes for a implementation identifier at the beginning. It doesn't provide any relevant information.
        const packet = (event.packet.startsWith('0x')
            ? event.packet.slice(2)
            : event.packet).slice(32 * 2);
        // Derive the message identifier

        const messageIdentifier = '0x' + packet.slice(2, 2 + 32 * 2);

        const transactionBlockNumber = await this.resolver.getTransactionBlockNumber(
            log.blockNumber
        );

        const amb: AmbMessage = {
            messageIdentifier,
            amb: 'polymer',
            sourceChain: this.chainId,
            destinationChain,
            sourceEscrow: event.sourcePortAddress,
            payload: packet,
            blockNumber: log.blockNumber,
            transactionBlockNumber,
            blockHash: log.blockHash,
            transactionHash: log.transactionHash
        };

        // Set the collect message  on-chain. This is not the proof but the raw message.
        // It can be used by plugins to facilitate other jobs.
        await this.store.setAmb(amb, log.transactionHash);

        this.logger.info(
            {
                messageIdentifier: amb.messageIdentifier,
                destinationChainId: destinationChain,
            },
            `Polymer message found.`,
        );
    }

}

void new PolymerCollectorSnifferWorker().run();
