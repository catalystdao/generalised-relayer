import pino from 'pino';
import { Store } from '../../store/store.lib';
import { workerData, MessagePort } from 'worker_threads';
import { LayerZeroWorkerData } from './engine';
import { AbiCoder, JsonRpcProvider, Log, LogDescription, zeroPadValue } from 'ethers6';
import { MonitorInterface, MonitorStatus } from '../../monitor/monitor.interface';
import { Resolver, loadResolver } from '../../resolvers/resolver';
import { ULNBaseInterface } from 'src/contracts/ULNBase';
import { ULNBase__factory } from 'src/contracts/factories/ULNBase__factory';
import { tryErrorToString, wait } from 'src/common/utils';

const abi = AbiCoder.defaultAbiCoder();

class ULNBaseWorker {

    private readonly config: LayerZeroWorkerData;

    private readonly chainId: string;
    private readonly incentivesAddress: string;
    private readonly ulnBaseInterface: ULNBaseInterface;
    private readonly filterTopics: string[][];

    private readonly resolver: Resolver;
    private readonly store: Store;
    private readonly provider: JsonRpcProvider;
    private readonly logger: pino.Logger;

    private currentStatus: MonitorStatus | null = null;
    private monitor: MonitorInterface;

    constructor() {
        this.config = workerData as LayerZeroWorkerData;

        this.chainId = this.config.chainId;

        this.store = new Store(this.chainId);
        this.provider = this.initializeProvider(this.config.rpc);
        this.logger = this.initializeLogger(this.chainId);
        this.resolver = this.loadResolver(
            this.config.resolver,
            this.provider,
            this.logger
        );

        this.incentivesAddress = this.config.incentivesAddress;
        this.ulnBaseInterface = ULNBase__factory.createInterface();
        this.filterTopics = [
            [this.ulnBaseInterface.getEvent('PayloadVerified').topicHash, zeroPadValue(this.incentivesAddress, 32)]
        ];

        this.monitor = this.startListeningToMonitor(this.config.monitorPort);
    }

    private initializeLogger(chainId: string): pino.Logger {
        return pino(this.config.loggerOptions).child({
            worker: 'collector-ULNBase-worker',
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

    async run(): Promise<void> {
        this.logger.info({ incentivesAddress: this.incentivesAddress }, `ULNBase worker started.`);

        let fromBlock = null;
        while (fromBlock == null) {
            if (this.currentStatus != null) {
                fromBlock = this.config.startingBlock ?? this.currentStatus.blockNumber;
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

                this.logger.info({ fromBlock, toBlock }, `Scanning PayloadVerified events.`);
                await this.queryAndProcessEvents(fromBlock, toBlock);

                if (toBlock >= stopBlock) {
                    this.logger.info({ stopBlock: toBlock }, `Finished processing blocks. Exiting worker.`);
                    break;
                }

                fromBlock = toBlock + 1;
            } catch (error) {
                this.logger.error(error, `Error on ULNBase worker`);
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
                this.logger.error({ log, error }, `Failed to process event on payload-verified worker.`);
            }
        }
    }

    private async queryLogs(fromBlock: number, toBlock: number): Promise<Log[]> {
        const filter = {
            address: this.incentivesAddress,
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
                this.logger.warn({ ...filter, error: tryErrorToString(error), try: i }, `Failed to 'getLogs' on payload-verified worker. Worker blocked until successful query.`);
                await wait(this.config.retryInterval);
            }
        }

        return logs;
    }

    private async handleEvent(log: Log): Promise<void> {
        const parsedLog = this.ulnBaseInterface.parseLog(log);

        if (parsedLog == null) {
            this.logger.error({ topics: log.topics, data: log.data }, `Failed to parse a PayloadVerified event.`);
            return;
        }

        if (parsedLog.name != 'PayloadVerified') {
            this.logger.warn({ name: parsedLog.name, topic: parsedLog.topic }, `Event with unknown name/topic received.`);
            return;
        }

        await this.handlePayloadVerifiedEvent(log, parsedLog);
    }

    private async handlePayloadVerifiedEvent(log: Log, parsedLog: LogDescription): Promise<void> {
        const event = parsedLog.args as unknown as { packet: string };

        const packet = (event.packet.startsWith('0x') ? event.packet.slice(2) : event.packet).slice(32 * 2);
        const messageIdentifier = '0x' + packet.slice(2, 2 + 32 * 2);

        this.logger.info({ messageIdentifier }, `PayloadVerified event found for message: ${messageIdentifier}`);

        // Update the store or handle the PayloadVerified event as needed.
    }
}

void new ULNBaseWorker().run();
