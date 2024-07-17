import { LogMessagePublishedEvent } from 'src/contracts/IWormhole';
import pino, { LoggerOptions } from 'pino';
import {
    IWormhole,
    IWormhole__factory,
    IncentivizedMessageEscrow,
    IncentivizedMessageEscrow__factory,
} from 'src/contracts';
import { Store } from 'src/store/store.lib';
import { workerData, MessagePort } from 'worker_threads';
import { tryErrorToString, wait } from '../../common/utils';
import { decodeWormholeMessage } from './wormhole.utils';
import { ParsePayload } from 'src/payload/decode.payload';
import { WormholeMessageSnifferWorkerData } from './wormhole.types';
import { AbiCoder, JsonRpcProvider } from 'ethers6';
import { MonitorInterface, MonitorStatus } from 'src/monitor/monitor.interface';
import { Resolver, loadResolver } from 'src/resolvers/resolver';
import { STATUS_LOG_INTERVAL } from 'src/logger/logger.service';
import { AMBMessage } from 'src/store/store.types';

const defaultAbiCoder = AbiCoder.defaultAbiCoder();

class WormholeMessageSnifferWorker {
    private readonly store: Store;
    private readonly logger: pino.Logger;

    private readonly config: WormholeMessageSnifferWorkerData;

    private readonly provider: JsonRpcProvider;

    private readonly chainId: string;

    private readonly wormholeContract: IWormhole;
    private readonly messageEscrowContract: IncentivizedMessageEscrow;

    private readonly resolver: Resolver;

    private currentStatus: MonitorStatus | null = null;
    private monitor: MonitorInterface;

    private fromBlock: number = 0;


    constructor() {
        this.config = workerData as WormholeMessageSnifferWorkerData;

        this.chainId = this.config.chainId;

        this.store = new Store();
        this.logger = this.initializeLogger(
            this.chainId,
            this.config.loggerOptions,
        );
        this.provider = this.initializeProvider(this.config.rpc);
        this.resolver = this.loadResolver(
            this.config.resolver,
            this.provider,
            this.logger
        );

        this.wormholeContract = this.initializeWormholeContract(
            this.config.wormholeAddress,
            this.provider,
        );

        this.messageEscrowContract = this.initializeMessageEscrowContract(
            this.config.incentivesAddress,
            this.provider,
        );

        this.monitor = this.startListeningToMonitor(this.config.monitorPort);

        this.initiateIntervalStatusLog();
    }

    // Initialization helpers
    // ********************************************************************************************

    private initializeLogger(
        chainId: string,
        loggerOptions: LoggerOptions,
    ): pino.Logger {
        return pino(loggerOptions).child({
            worker: 'collector-wormhole-message-sniffer',
            chain: chainId,
        });
    }

    private initializeProvider(rpc: string): JsonRpcProvider {
        return new JsonRpcProvider(rpc, undefined, { staticNetwork: true });
    }

    private loadResolver(
        resolver: string | null,
        provider: JsonRpcProvider,
        logger: pino.Logger
    ): Resolver {
        return loadResolver(resolver, provider, logger);
    }

    private initializeWormholeContract(
        wormholeAddress: string,
        provider: JsonRpcProvider,
    ): IWormhole {
        return IWormhole__factory.connect(wormholeAddress, provider);
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
            { wormholeAddress: this.config.wormholeAddress },
            `Wormhole worker started.`,
        );

        this.fromBlock = await this.getStartingBlock();
        const stopBlock = this.config.stoppingBlock ?? Infinity;

        while (true) {
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

            this.logger.debug(
                {
                    fromBlock: this.fromBlock,
                    toBlock,
                },
                `Scanning wormhole messages.`,
            );

            const logs = await this.queryLogs(this.fromBlock, toBlock);

            for (const log of logs) {
                try {
                    await this.handleLogMessagedPublishedEvent(log);
                } catch (error) {
                    this.logger.error(
                        { log, error },
                        'Failed to process LogMessagePublishedEvent on Wormhole sniffer worker.',
                    );
                }
            }

            if (toBlock >= stopBlock) {
                this.logger.info(
                    { stopBlock: toBlock },
                    `Finished processing blocks. Exiting worker.`,
                );
                break;
            }

            this.fromBlock = toBlock + 1;

            await wait(this.config.processingInterval);
        }

        // Cleanup worker
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

    private async queryLogs(
        fromBlock: number,
        toBlock: number,
    ): Promise<LogMessagePublishedEvent.Log[]> {
        const filter = this.wormholeContract.filters.LogMessagePublished(
            this.config.incentivesAddress,
        );

        let logs: LogMessagePublishedEvent.Log[] | undefined;
        let i = 0;
        while (logs == undefined) {
            try {
                logs = await this.wormholeContract.queryFilter(
                    filter,
                    fromBlock,
                    toBlock,
                );
            } catch (error) {
                i++;
                this.logger.warn(
                    { ...filter, error: tryErrorToString(error), try: i },
                    `Failed to get 'LogMessagePublished' events on WormholeMessageSnifferWorker. Worker blocked until successful query.`,
                );
                await wait(this.config.retryInterval);
            }
        }

        return logs;
    }

    private async handleLogMessagedPublishedEvent(
        log: LogMessagePublishedEvent.Log,
    ): Promise<void> {
        const payload = log.args.payload;
        const decodedWormholeMessage = decodeWormholeMessage(payload);

        this.logger.info(
            { messageIdentifier: decodedWormholeMessage.messageIdentifier },
            `Collected message.`,
        );

        const destinationWormholeChainId = decodedWormholeMessage.destinationWormholeChainId;
        const destinationChain = this.config.wormholeChainIdMap.get(destinationWormholeChainId);

        if (destinationChain == undefined) {
            this.logger.info(
                {
                    messageIdentifier: decodedWormholeMessage.messageIdentifier,
                    destinationWormholeChainId
                },
                `Unable to determine the destination chain id. Skipping message.`
            );
            return;
        }

        const transactionBlockNumber = await this.resolver.getTransactionBlockNumber(
            log.blockNumber
        );

        // Decode payload
        const decodedPayload = ParsePayload(decodedWormholeMessage.payload);
        if (decodedPayload === undefined) {
            this.logger.info('Could not decode payload.');
            return;
        }

        //TODO the following contract call could fail. Set to 'undefined' and continue on that case?
        //TODO cache the query
        const toIncentivesAddress = await this.messageEscrowContract.implementationAddress(
            decodedPayload?.sourceApplicationAddress,
            defaultAbiCoder.encode(['uint256'], [destinationChain]),
        );

        const ambMessage: AMBMessage = {
            messageIdentifier: decodedWormholeMessage.messageIdentifier,

            amb: 'wormhole',
            fromChainId: this.chainId,
            toChainId: destinationChain,
            fromIncentivesAddress: log.args.sender,
            toIncentivesAddress,

            incentivesPayload: decodedWormholeMessage.payload,
            recoveryContext: log.args.sequence.toString(),

            transactionBlockNumber,

            blockNumber: log.blockNumber,
            blockHash: log.blockHash,
            transactionHash: log.transactionHash,
        };

        await this.store.setAMBMessage(
            this.chainId,
            ambMessage,
        );
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
                'Wormhole message sniffer status.'
            );
        };
        setInterval(logStatus, STATUS_LOG_INTERVAL);
    }
}

void new WormholeMessageSnifferWorker().run();
