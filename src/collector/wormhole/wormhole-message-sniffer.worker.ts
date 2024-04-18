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

const defaultAbiCoder = AbiCoder.defaultAbiCoder();

class WormholeMessageSnifferWorker {
    readonly store: Store;
    readonly logger: pino.Logger;

    readonly config: WormholeMessageSnifferWorkerData;

    readonly provider: JsonRpcProvider;

    readonly chainId: string;

    readonly wormholeContract: IWormhole;
    readonly messageEscrowContract: IncentivizedMessageEscrow;

    readonly resolver: Resolver;

    private currentStatus: MonitorStatus | null;
    private monitor: MonitorInterface;


    constructor() {
        this.config = workerData as WormholeMessageSnifferWorkerData;

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

            this.logger.info(
                {
                    fromBlock,
                    toBlock,
                },
                `Scanning wormhole messages.`,
            );

            const logs = await this.queryLogs(fromBlock, toBlock);

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

            fromBlock = toBlock + 1;

            await wait(this.config.processingInterval);
        }

        // Cleanup worker
        this.monitor.close();
        await this.store.quit();
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

        await this.store.setAmb(
            {
                messageIdentifier: decodedWormholeMessage.messageIdentifier,
                amb: 'wormhole',
                sourceChain: this.chainId,
                destinationChain,
                sourceEscrow: log.args.sender,
                payload: decodedWormholeMessage.payload,
                recoveryContext: log.args.sequence.toString(),
                blockNumber: log.blockNumber,
                transactionBlockNumber,
                blockHash: log.blockHash,
                transactionHash: log.transactionHash,
            },
            log.transactionHash,
        );

        // Decode payload
        const decodedPayload = ParsePayload(decodedWormholeMessage.payload);
        if (decodedPayload === undefined) {
            this.logger.info('Could not decode payload.');
            return;
        }

        // Set destination address for the bounty.
        await this.store.registerDestinationAddress({
            messageIdentifier: decodedWormholeMessage.messageIdentifier,
            //TODO the following contract call could fail
            destinationAddress:
                await this.messageEscrowContract.implementationAddress(
                    decodedPayload?.sourceApplicationAddress,
                    defaultAbiCoder.encode(['uint256'], [destinationChain]),
                ),
        });
    }
}

void new WormholeMessageSnifferWorker().run();
