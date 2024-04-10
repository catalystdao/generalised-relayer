import { tryErrorToString, wait } from 'src/common/utils';
import pino from 'pino';
import { workerData } from 'worker_threads';
import { IMessageEscrowEvents__factory } from 'src/contracts';
import { Store } from 'src/store/store.lib';
import { GetterWorkerData } from './getter.controller';
import { JsonRpcProvider, Log, LogDescription } from 'ethers6';
import { BountyClaimedEvent, BountyIncreasedEvent, BountyPlacedEvent, IMessageEscrowEventsInterface, MessageDeliveredEvent } from 'src/contracts/IMessageEscrowEvents';

const GET_LOGS_RETRY_INTERVAL = 2000;

class GetterWorker {
    readonly store: Store;
    readonly logger: pino.Logger;

    readonly config: GetterWorkerData;

    readonly provider: JsonRpcProvider;

    readonly chainId: string;
    readonly chainName: string;

    readonly incentivesEscrowInterface: IMessageEscrowEventsInterface;
    readonly addresses: string[];
    readonly topics: string[][];


    constructor() {
        this.config = workerData as GetterWorkerData;

        this.chainId = this.config.chainId;

        this.store = new Store(this.chainId);
        this.logger = this.initializeLogger(this.chainId);
        this.provider = this.initializeProvider(this.config.rpc);

        const contractTypes = this.initializeContractTypes();
        this.incentivesEscrowInterface = contractTypes.chainInterfaceInterface;
        this.topics = contractTypes.topics;
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



    // Main handler
    // ********************************************************************************************
    async run(): Promise<void> {
        this.logger.info(
            { incentiveAddresses: this.addresses },
            `Getter worker started.`,
        );

        let startBlock = this.config.startingBlock
            ?? (await this.provider.getBlockNumber()) - this.config.blockDelay;

        const stopBlock = this.config.stoppingBlock ?? Infinity;

        await wait(this.config.interval);

        while (true) {
            try {
                let endBlock: number;
                try {
                    endBlock = (await this.provider.getBlockNumber()) - this.config.blockDelay;
                } catch (error) {
                    this.logger.error(
                        error,
                        `Failed to get the current block number on the getter.`,
                    );
                    await wait(GET_LOGS_RETRY_INTERVAL);
                    continue;
                }

                if (!endBlock || startBlock > endBlock) {
                    await wait(this.config.interval);
                    continue;
                }

                if (endBlock > stopBlock) {
                    endBlock = stopBlock;
                }

                const blocksToProcess = endBlock - startBlock;
                if (this.config.maxBlocks != null && blocksToProcess > this.config.maxBlocks) {
                    endBlock = startBlock + this.config.maxBlocks;
                }

                this.logger.info(
                    {
                      startBlock,
                      endBlock,
                    },
                    `Scanning bounties.`,
                );

                await this.queryAndProcessEvents(startBlock, endBlock);
                
                if (endBlock >= stopBlock) {
                    this.logger.info(
                    { endBlock },
                    `Finished processing blocks. Exiting worker.`,
                    );
                    break;
                }

                startBlock = endBlock + 1;
            }
            catch (error) {
                this.logger.error(error, `Failed on getter.worker`);
                await wait(GET_LOGS_RETRY_INTERVAL)
            }

            await wait(this.config.interval);
        }

        // Cleanup worker
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
            address: this.addresses,
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
                await wait(GET_LOGS_RETRY_INTERVAL);
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