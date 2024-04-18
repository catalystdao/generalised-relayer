import pino from 'pino';
import { tryErrorToString, wait } from 'src/common/utils';
import { IbcEventEmitter__factory } from 'src/contracts';
import { Store } from 'src/store/store.lib';
import { AmbMessage } from 'src/store/types/store.types';
import { workerData, MessagePort } from 'worker_threads';
import { PolymerWorkerData } from './polymer';
import { AbiCoder, JsonRpcProvider, Log, LogDescription } from 'ethers6';
import { IbcEventEmitterInterface, SendPacketEvent } from 'src/contracts/IbcEventEmitter';
import { MonitorInterface, MonitorStatus } from 'src/monitor/monitor.interface';
import { Resolver, loadResolver } from 'src/resolvers/resolver';

const abi = AbiCoder.defaultAbiCoder();

class PolymerCollectorSnifferWorker {

    readonly config: PolymerWorkerData;

    readonly chainId: string;

    readonly incentivesAddress: string;
    readonly polymerAddress: string;
    readonly ibcEventEmitterInterface: IbcEventEmitterInterface;
    readonly filterTopics: string[][];

    readonly resolver: Resolver;
    readonly store: Store;
    readonly provider: JsonRpcProvider;
    readonly logger: pino.Logger;

    private currentStatus: MonitorStatus | null;
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
        this.filterTopics = [[this.ibcEventEmitterInterface.getEvent('SendPacket').topicHash]];

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
            // Do not initialize 'startBlock' whilst 'currentStatus' is null, even if
            // 'startingBlock' is specified.
            if (this.currentStatus != null) {
                fromBlock = (
                    this.config.startingBlock ?? this.currentStatus.observedBlockNumber
                );
            }
            
            await wait(this.config.processingInterval);
        }
        const stopBlock = this.config.stoppingBlock ?? Infinity;

        while (true) {
            try {
                let toBlock = this.currentStatus?.observedBlockNumber;
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
        const destinationChain: string = event.sourceChannelId;

        // Decode the Universal channel payload
        const packet = event.packet.startsWith('0x')
            ? event.packet.slice(2)
            : event.packet;

        let params: [string, bigint, string, string];
        try {
            params = abi.decode(
                ['tuple(bytes32, uint256, bytes32, bytes)'],
                event.packet,
            )[0];
        } catch (error) {
            this.logger.debug(
                {
                    error: tryErrorToString(error),
                },
                `Couldn't decode a Polymer message. Likely because it is not a UniversalChannel Package.`,
            );
            return;
        }

        const incentivisedMessageEscrowFromPacket: string =
            '0x' + params[0].replaceAll('0x', '').slice(12 * 2);

        if (
            incentivisedMessageEscrowFromPacket.toLowerCase() !=
                this.config.incentivesAddress.toLowerCase() ||
            packet.length <= 384 + 64 * 2
        ) {
            return;
        }

        // Derive the message identifier
        const messageIdentifier = '0x' + params[3]
            .replaceAll('0x', '').slice(1 * 2, 1 * 2 + 32 * 2);

        const transactionBlockNumber = await this.resolver.getTransactionBlockNumber(
            log.blockNumber
        );

        const amb: AmbMessage = {
            messageIdentifier,
            amb: 'polymer',
            sourceChain: this.chainId,
            destinationChain,
            sourceEscrow: "", // ! TODO implement (important for underwriting)
            payload: params[3],
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