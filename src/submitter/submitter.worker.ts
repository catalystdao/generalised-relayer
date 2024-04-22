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
import { EvalOrder, NewOrder } from './submitter.types';
import { EvalQueue } from './queues/eval-queue';
import { SubmitQueue } from './queues/submit-queue';
import { wait } from 'src/common/utils';
import { SubmitterWorkerData } from './submitter.service';
import { WalletInterface } from 'src/wallet/wallet.interface';

class SubmitterWorker {
    readonly store: Store;
    readonly logger: pino.Logger;

    readonly config: SubmitterWorkerData;

    readonly provider: JsonRpcProvider;
    readonly signer: Wallet;

    readonly chainId: string;

    readonly wallet: WalletInterface;

    readonly newOrdersQueue: NewOrder<EvalOrder>[] = [];
    readonly evalQueue: EvalQueue;
    readonly submitQueue: SubmitQueue;

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

        this.wallet = new WalletInterface(this.config.walletPort);

        [this.evalQueue, this.submitQueue] =
      this.initializeQueues(
          this.config.retryInterval,
          this.config.maxTries,
          this.store,
          this.loadIncentivesContracts(this.config.incentivesAddresses),
          this.config.chainId,
          this.config.gasLimitBuffer,
          this.config.walletPublicKey,
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
        store: Store,
        incentivesContracts: Map<string, IncentivizedMessageEscrow>,
        chainId: string,
        gasLimitBuffer: Record<string, number>,
        walletPublicKey: string,
        wallet: WalletInterface,
        logger: pino.Logger,
    ): [EvalQueue, SubmitQueue] {
        const evalQueue = new EvalQueue(
            retryInterval,
            maxTries,
            store,
            incentivesContracts,
            chainId,
            gasLimitBuffer,
            walletPublicKey,
            logger,
        );

        const submitQueue = new SubmitQueue(
            retryInterval,
            maxTries,
            incentivesContracts,
            walletPublicKey,
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
                newOrdersQueue: this.newOrdersQueue.length,
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
            const evalOrders = await this.processNewOrdersQueue();

            await this.evalQueue.addOrders(...evalOrders);
            await this.evalQueue.processOrders();

            const [newSubmitOrders, ,] = this.evalQueue.getFinishedOrders();
            await this.submitQueue.addOrders(...newSubmitOrders);
            await this.submitQueue.processOrders();

            this.submitQueue.getFinishedOrders(); // Flush the internal queues

            await wait(this.config.processingInterval);
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

        await this.store.on(listenToChannel, (message: AmbPayload) => {
            void this.store.getAmb(message.messageIdentifier)
                .then(ambMessage => {
                    if (ambMessage == null) {
                        this.logger.warn(
                            {
                                messageIdentifier: message.messageIdentifier,
                            },
                            `AMB message not found on submit order. Priority set to 'false'.`
                        )
                    }

                    return this.addSubmitOrder(
                        message.amb,
                        message.messageIdentifier,
                        message.message,
                        message.messageCtx ?? '',
                        ambMessage?.priority ?? false, // eval priority => undefined = false.
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
    ) {
        this.logger.debug(
            { messageIdentifier, priority },
            `Submit order received.`,
        );
        if (priority) {
            // Push directly into the submit queue
            await this.evalQueue.addOrders({
                amb,
                messageIdentifier,
                message,
                messageCtx,
                priority: true,
            });
        } else {
            // Push into the evaluation queue
            this.newOrdersQueue.push({
                processAt: Date.now() + this.config.newOrdersDelay,
                order: {
                    amb,
                    messageIdentifier,
                    message,
                    messageCtx,
                    priority: false,
                },
            });
        }
    }

    /***************  New Order Queue  ***************/

    private async processNewOrdersQueue(): Promise<EvalOrder[]> {
        const currentTimestamp = Date.now();
        const capacity = this.getSubmitterCapacity();

        let i;
        for (i = 0; i < this.newOrdersQueue.length; i++) {
            const nextNewOrder = this.newOrdersQueue[i];

            if (nextNewOrder.processAt > currentTimestamp || i + 1 > capacity) {
                break;
            }
        }

        const ordersToEval = this.newOrdersQueue.splice(0, i).map((newOrder) => {
            return newOrder.order;
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
