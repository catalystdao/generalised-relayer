import {
    BytesLike,
    JsonRpcProvider,
    Wallet,
} from 'ethers6';
import pino, { LoggerOptions } from 'pino';
import { Store } from 'src/store/store.lib';
import { IncentivizedMessageEscrow } from 'src/contracts';
import { IncentivizedMessageEscrow__factory } from 'src/contracts/factories/IncentivizedMessageEscrow__factory';
import { workerData } from 'worker_threads';
import { AmbPayload } from 'src/store/types/store.types';
import { STATUS_LOG_INTERVAL } from 'src/logger/logger.service';
import { BountyEvaluationConfig, EvalOrder, PendingOrder } from './submitter.types';
import { EvalQueue } from './queues/eval-queue';
import { SubmitQueue } from './queues/submit-queue';
import { wait } from 'src/common/utils';
import { SubmitterWorkerData } from './submitter.service';
import { WalletInterface } from 'src/wallet/wallet.interface';
import { PricingInterface } from 'src/pricing/pricing.interface';

class SubmitterWorker {
    private readonly store: Store;
    private readonly logger: pino.Logger;

    private readonly config: SubmitterWorkerData;

    private readonly provider: JsonRpcProvider;
    private readonly signer: Wallet;

    private readonly chainId: string;

    private readonly pricing: PricingInterface;
    private readonly wallet: WalletInterface;

    private readonly pendingQueue: PendingOrder<EvalOrder>[] = [];
    private readonly evalQueue: EvalQueue;
    private readonly submitQueue: SubmitQueue;

    private isStalled = false;

    constructor() {
        this.config = workerData as SubmitterWorkerData;

        this.chainId = this.config.chainId;

        this.store = new Store(this.chainId);
        this.logger = this.initializeLogger(
            this.chainId,
            this.config.loggerOptions,
        );
        this.provider = new JsonRpcProvider(this.config.rpc, undefined, {
            staticNetwork: true,
        });
        this.signer = new Wallet(this.config.relayerPrivateKey, this.provider);

        this.pricing = new PricingInterface(this.config.pricingPort);
        this.wallet = new WalletInterface(this.config.walletPort);

        [this.evalQueue, this.submitQueue] =
            this.initializeQueues(
                this.config.retryInterval,
                this.config.maxTries,
                this.config.walletPublicKey,
                this.store,
                this.loadIncentivesContracts(this.config.incentivesAddresses),
                this.config.chainId,
                {
                    evaluationRetryInterval: this.config.evaluationRetryInterval,
                    maxEvaluationDuration: this.config.maxEvaluationDuration,
                    unrewardedDeliveryGas: this.config.unrewardedDeliveryGas,
                    minDeliveryReward: this.config.minDeliveryReward,
                    relativeMinDeliveryReward: this.config.relativeMinDeliveryReward,
                    unrewardedAckGas: this.config.unrewardedAckGas,
                    minAckReward: this.config.minAckReward,
                    relativeMinAckReward: this.config.relativeMinAckReward,
                    profitabilityFactor: this.config.profitabilityFactor,
                },
                this.pricing,
                this.wallet,
                this.logger,
            );

        this.initiateIntervalStatusLog();
    }

    /***************  Submitter Init Helpers  ***************/

    private initializeLogger(
        chainId: string,
        loggerOptions: LoggerOptions,
    ): pino.Logger {
        return pino(loggerOptions).child({
            worker: 'submitter',
            chain: chainId,
        });
    }

    private initializeQueues(
        retryInterval: number,
        maxTries: number,
        walletPublicKey: string,
        store: Store,
        incentivesContracts: Map<string, IncentivizedMessageEscrow>,
        chainId: string,
        bountyEvaluationConfig: BountyEvaluationConfig,
        pricing: PricingInterface,
        wallet: WalletInterface,
        logger: pino.Logger,
    ): [EvalQueue, SubmitQueue] {
        const evalQueue = new EvalQueue(
            retryInterval,
            maxTries,
            walletPublicKey,
            store,
            incentivesContracts,
            chainId,
            bountyEvaluationConfig,
            pricing,
            wallet,
            logger,
        );

        const submitQueue = new SubmitQueue(
            retryInterval,
            maxTries,
            store,
            incentivesContracts,
            walletPublicKey,
            chainId,
            wallet,
            logger,
        );

        return [evalQueue, submitQueue];
    }

    /**
     * Start a logger which reports the current submitter queue status.
     */
    private initiateIntervalStatusLog(): void {
        this.logger.info('Submitter worker started.');

        const logStatus = () => {
            const status = {
                capacity: this.getSubmitterCapacity(),
                pendingQueue: this.pendingQueue.length,
                evalQueue: this.evalQueue.size,
                evalRetryQueue: this.evalQueue.retryQueue.length,
                submitQueue: this.submitQueue.size,
                submitRetryQueue: this.submitQueue.retryQueue.length,
                isStalled: this.isStalled,
            };
            this.logger.info(status, 'Submitter status.');
        };
        setInterval(logStatus, STATUS_LOG_INTERVAL);
    }

    private loadIncentivesContracts(
        incentivesAddresses: Map<string, string>,
    ): Map<string, IncentivizedMessageEscrow> {
        const incentivesContracts = new Map<string, IncentivizedMessageEscrow>();

        incentivesAddresses.forEach((address: string, amb: string) => {
            const contract = IncentivizedMessageEscrow__factory.connect(
                address,
                this.signer,
            );
            incentivesContracts.set(amb, contract);
        });

        return incentivesContracts;
    }

    /***************  Main Logic Loop.  ***************/

    async run(): Promise<void> {
        this.logger.debug({ relayer: this.signer.address }, `Relaying messages.`);

        // Initialize the queues
        await this.evalQueue.init();
        await this.submitQueue.init();

        // Start listener.
        await this.listenForOrders();

        while (true) {
            const evalOrders = await this.processPendingQueue();

            await this.evalQueue.addOrders(...evalOrders);
            await this.evalQueue.processOrders();

            const [newSubmitOrders, noSubmitEvalOrders,] = this.evalQueue.getFinishedOrders();
            this.processNoSubmitEvalOrders(noSubmitEvalOrders);
            await this.submitQueue.addOrders(...newSubmitOrders);
            await this.submitQueue.processOrders();

            //TODO process failed submissions in any way?

            this.submitQueue.getFinishedOrders(); // Flush the internal queues

            await wait(this.config.processingInterval);
        }
    }

    private processNoSubmitEvalOrders(evalOrders: EvalOrder[]): void {
        for (const order of evalOrders) {
            if (order.retryEvaluation) {

                // Clear the 'retryEvaluation' flag to avoid unexpected retries.
                order.retryEvaluation = undefined;

                const nextEvaluationTime = Date.now() + this.config.evaluationRetryInterval;
                if (nextEvaluationTime > order.evaluationDeadline) {
                    this.logger.info(
                        {
                            messageIdentifier: order.messageIdentifier,
                            nextEvaluationTime,
                            evaluationDeadline: order.evaluationDeadline,
                        },
                        'Dropping evaluation order.'
                    );
                }
                else {
                    this.logger.info(
                        {
                            messageIdentifier: order.messageIdentifier,
                            nextEvaluationTime,
                            evaluationDeadline: order.evaluationDeadline,
                        },
                        'Queueing order for reevaluation.'
                    );
                    this.addPendingOrder(nextEvaluationTime, order);
                }
            }
        }
    }

    /**
     * Subscribe to the Store to listen for relevant payloads to submit.
     */
    private async listenForOrders(): Promise<void> {
        const listenToChannel = Store.getChannel('submit', this.chainId);
        this.logger.info(
            { globalChannel: listenToChannel },
            `Listing for messages to submit.`,
        );

        await this.store.on(listenToChannel, (event: any) => {

            //TODO verify event format
            const message = event as AmbPayload;

            void this.store.getAmb(message.messageIdentifier)
                .then(ambMessage => {
                    if (ambMessage == null) {
                        this.logger.warn(
                            {
                                messageIdentifier: message.messageIdentifier,
                            },
                            `AMB message not found on submit order. Submission evaluation will be less accurate.`
                        );
                    }

                    return this.addSubmitOrder(
                        message.amb,
                        message.messageIdentifier,
                        message.message,
                        message.messageCtx ?? '',
                        ambMessage?.priority ?? false, // eval priority => undefined = false.
                        ambMessage?.payload,
                    );
                })
        });
    }

    private async addSubmitOrder(
        amb: string,
        messageIdentifier: string,
        message: BytesLike,
        messageCtx: BytesLike,
        priority: boolean,
        incentivesPayload?: BytesLike,
    ) {
        this.logger.debug(
            { messageIdentifier, priority },
            `Submit order received.`,
        );
        if (priority) {
            // Push directly into the eval queue
            await this.evalQueue.addOrders({
                amb,
                messageIdentifier,
                message,
                messageCtx,
                priority: true,
                evaluationDeadline: Date.now() + this.config.maxEvaluationDuration,
                incentivesPayload,
            });
        } else {
            // Push into the pending queue
            this.addPendingOrder(
                Date.now() + this.config.newOrdersDelay,
                {
                    amb,
                    messageIdentifier,
                    message,
                    messageCtx,
                    priority: false,
                    evaluationDeadline: Date.now() + this.config.maxEvaluationDuration,
                    incentivesPayload,
                },
            );
        }
    }

    /***************  Pending Orders Queue  ***************/

    private addPendingOrder(processAt: number, order: EvalOrder): void {
        
        // Insert the new order into the 'pendingQueue' keeping the queue order.
        const insertIndex = this.pendingQueue.findIndex(order => {
            return order.processAt > processAt;
        });

        const pendingOrder: PendingOrder<EvalOrder> = {
            order,
            processAt
        };

        if (insertIndex == -1) {
            this.pendingQueue.push(pendingOrder);
        } else {
            this.pendingQueue.splice(insertIndex, 0, pendingOrder);
        }
    }

    private async processPendingQueue(): Promise<EvalOrder[]> {
        const currentTimestamp = Date.now();
        const capacity = this.getSubmitterCapacity();

        let i;
        for (i = 0; i < this.pendingQueue.length; i++) {
            const nextPendingOrder = this.pendingQueue[i]!;

            if (nextPendingOrder.processAt > currentTimestamp || i + 1 > capacity) {
                break;
            }
        }

        const ordersToEval = this.pendingQueue.splice(0, i).map((pendingOrder) => {
            return pendingOrder.order;
        });

        return ordersToEval;
    }

    // Assocaited Helpers for New Order Queue.

    /**
     * Get the current Submitter Capacity.
     */
    private getSubmitterCapacity(): number {
        return Math.max(
            0,
            this.config.maxPendingTransactions -
            this.evalQueue.size -
            this.submitQueue.size
        );
    }
}

void new SubmitterWorker().run();
