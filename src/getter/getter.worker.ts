import { tryErrorToString, wait } from 'src/common/utils';
import pino from 'pino';
import { workerData, MessagePort } from 'worker_threads';
import { IMessageEscrowEvents__factory } from 'src/contracts';
import { Store } from 'src/store/store.lib';
import { GetterWorkerData } from './getter.service';
import { JsonRpcProvider, Log, LogDescription } from 'ethers6';
import { BountyClaimedEvent, BountyIncreasedEvent, BountyPlacedEvent, IMessageEscrowEventsInterface, MessageDeliveredEvent } from 'src/contracts/IMessageEscrowEvents';
import { MonitorInterface, MonitorStatus } from 'src/monitor/monitor.interface';

class GetterWorker {

    private readonly config: GetterWorkerData;

    private readonly chainId: string;

    private readonly incentivesEscrowInterface: IMessageEscrowEventsInterface;
    private readonly incentiveAddresses: string[];
    private readonly topics: string[][];

    private readonly store: Store;
    private readonly provider: JsonRpcProvider;
    private readonly logger: pino.Logger;

    private currentStatus: MonitorStatus | null = null;
    private monitor: MonitorInterface;


    constructor() {
        this.config = workerData as GetterWorkerData;

        this.chainId = this.config.chainId;

        this.store = new Store(this.chainId);
        this.provider = this.initializeProvider(this.config.rpc);
        this.logger = this.initializeLogger(this.chainId);

        this.incentiveAddresses = this.config.incentivesAddresses;
        const contractTypes = this.initializeContractTypes();
        this.incentivesEscrowInterface = contractTypes.chainInterfaceInterface;
        this.topics = contractTypes.topics;

        this.monitor = this.startListeningToMonitor(this.config.monitorPort);
    }



    // Initialization helpers
    // ********************************************************************************************

    private initializeLogger(chainId: string): pino.Logger {
        return pino(this.config.loggerOptions).child({
            worker: 'getter',
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

    private initializeContractTypes(): {
        chainInterfaceInterface: IMessageEscrowEventsInterface,
        topics: string[][]
        } {

        const chainInterfaceInterface = IMessageEscrowEvents__factory.createInterface();
        const topics = [
            [
                chainInterfaceInterface.getEvent('BountyPlaced').topicHash,
                chainInterfaceInterface.getEvent('BountyClaimed').topicHash,
                chainInterfaceInterface.getEvent('MessageDelivered').topicHash,
                chainInterfaceInterface.getEvent('BountyIncreased').topicHash,
            ]
        ];

        return {
            chainInterfaceInterface,
            topics
        }
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
            { incentiveAddresses: this.incentiveAddresses },
            `Getter worker started.`,
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
                    `Scanning bounties.`,
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
                this.logger.error(error, `Failed on getter.worker`);
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
                    `Failed to process event on getter worker.`
                );
            }
        }
    }

    private async queryLogs(
        fromBlock: number,
        toBlock: number
    ): Promise<Log[]> {
        const filter = {
            address: this.incentiveAddresses,
            topics: this.topics,
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
                    `Failed to 'getLogs' on getter. Worker blocked until successful query.`
                );
                await wait(this.config.retryInterval);
            }
        }

        return logs;
    }

    // Event handlers
    // ********************************************************************************************

    private async handleEvent(log: Log): Promise<void> {
        const parsedLog = this.incentivesEscrowInterface.parseLog(log);

        if (parsedLog == null) {
            this.logger.error(
                { topics: log.topics, data: log.data },
                `Failed to parse GeneralisedIncentives contract event.`,
            );
            return;
        }

        switch (parsedLog.name) {
            case 'BountyPlaced':
                await this.handleBountyPlacedEvent(log, parsedLog);
                break;
  
            case 'BountyClaimed':
                await this.handleBountyClaimedEvent(log, parsedLog);
                break;
  
            case 'MessageDelivered':
                await this.handleMessageDeliveredEvent(log, parsedLog);
                break;
  
            case 'BountyIncreased':
                await this.handleBountyIncreasedEvent(log, parsedLog);
                break;

            default:
                this.logger.warn(
                    { name: parsedLog.name, topic: parsedLog.topic },
                    `Event with unknown name/topic received.`,
                );
        }

    }


    private async handleBountyPlacedEvent(
        log: Log,
        parsedLog: LogDescription
    ): Promise<void> {

        const event = parsedLog.args as unknown as BountyPlacedEvent.OutputObject;

        const messageIdentifier = event.messageIdentifier;
        const incentive = event.incentive;
    
        this.logger.info({ messageIdentifier }, `BountyPlaced event found.`);
    
        await this.store.registerBountyPlaced({
            messageIdentifier,
            incentive,
            incentivesAddress: log.address,
            transactionHash: log.transactionHash,
        });
    };
    
    private async handleBountyClaimedEvent(
        log: Log,
        parsedLog: LogDescription
    ): Promise<void> {

        const event = parsedLog.args as unknown as BountyClaimedEvent.OutputObject;

        const messageIdentifier = event.uniqueIdentifier;
    
        this.logger.info({ messageIdentifier }, `BountyClaimed event found.`);
    
        await this.store.registerBountyClaimed({
            messageIdentifier,
            incentivesAddress: log.address,
            transactionHash: log.transactionHash,
        });
    };
    
    private async handleMessageDeliveredEvent(
        log: Log,
        parsedLog: LogDescription
    ): Promise<void> {

        const event = parsedLog.args as unknown as MessageDeliveredEvent.OutputObject;

        const messageIdentifier = event.messageIdentifier;
    
        this.logger.info({ messageIdentifier }, `MessageDelivered event found.`);
    
        await this.store.registerMessageDelivered({
            messageIdentifier,
            incentivesAddress: log.address,
            transactionHash: log.transactionHash,
        });
    };
    
    private async handleBountyIncreasedEvent(
        log: Log,
        parsedLog: LogDescription
    ): Promise<void> {

        const event = parsedLog.args as unknown as BountyIncreasedEvent.OutputObject;

        const messageIdentifier = event.messageIdentifier;
    
        this.logger.info({ messageIdentifier }, `BountyIncreased event found.`);
    
        await this.store.registerBountyIncreased({
            messageIdentifier,
            newDeliveryGasPrice: event.newDeliveryGasPrice,
            newAckGasPrice: event.newAckGasPrice,
            incentivesAddress: log.address,
            transactionHash: log.transactionHash,
        });
    };

}

void new GetterWorker().run();