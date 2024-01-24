import { BytesLike, ContractTransaction, Wallet, constants } from 'ethers';
import { StaticJsonRpcProvider } from '@ethersproject/providers';
import pino, { LoggerOptions } from 'pino';
import { Store } from 'src/store/store.lib';
import { IncentivizedMessageEscrow } from 'src/contracts';
import { IncentivizedMessageEscrow__factory } from 'src/contracts/factories/IncentivizedMessageEscrow__factory';
import { workerData } from 'worker_threads';
import { AmbPayload } from 'src/store/types/store.types';
import { STATUS_LOG_INTERVAL } from 'src/logger/logger.service';
import {
  EvalOrder,
  GasFeeConfig,
  NewOrder,
  SubmitOrder,
  SubmitOrderResult,
} from './submitter.types';
import { EvalQueue } from './queues/eval-queue';
import { SubmitQueue } from './queues/submit-queue';
import { wait } from 'src/common/utils';
import { SubmitterWorkerData } from './submitter.service';
import { TransactionHelper } from './transaction-helper';
import { ConfirmQueue } from './queues/confirm-queue';

class SubmitterWorker {
  readonly store: Store;
  readonly logger: pino.Logger;

  readonly config: SubmitterWorkerData;

  readonly provider: StaticJsonRpcProvider;
  readonly signer: Wallet;

  readonly chainId: string;

  readonly transactionHelper: TransactionHelper;

  readonly newOrdersQueue: NewOrder<EvalOrder>[] = [];
  readonly evalQueue: EvalQueue;
  readonly submitQueue: SubmitQueue;
  readonly confirmQueue: ConfirmQueue;

  private isStalled = false;

  constructor() {
    this.config = workerData as SubmitterWorkerData;

    this.chainId = this.config.chainId;

    this.store = new Store(this.chainId);
    this.logger = this.initializeLogger(
      this.chainId,
      this.config.loggerOptions,
    );
    this.provider = new StaticJsonRpcProvider(this.config.rpc);
    this.signer = new Wallet(this.config.relayerPrivateKey, this.provider);

    this.transactionHelper = new TransactionHelper(
      this.getGasFeeConfig(this.config),
      this.config.retryInterval,
      this.signer,
      this.logger,
    );

    [this.evalQueue, this.submitQueue, this.confirmQueue] =
      this.initializeQueues(
        this.config.retryInterval,
        this.config.maxTries,
        this.store,
        this.loadIncentivesContracts(this.config.incentivesAddresses),
        this.config.chainId,
        this.config.gasLimitBuffer,
        this.config.confirmationTimeout,
        this.transactionHelper,
        this.signer,
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
    confirmationTimeout: number,
    transactionHelper: TransactionHelper,
    signer: Wallet,
    logger: pino.Logger,
  ): [EvalQueue, SubmitQueue, ConfirmQueue] {
    const evalQueue = new EvalQueue(
      retryInterval,
      maxTries,
      store,
      incentivesContracts,
      chainId,
      gasLimitBuffer,
      signer,
      logger,
    );

    const submitQueue = new SubmitQueue(
      retryInterval,
      maxTries,
      incentivesContracts,
      transactionHelper,
      confirmationTimeout,
      signer,
      logger,
    );

    const confirmQueue = new ConfirmQueue(
      retryInterval,
      maxTries,
      1, //TODO set 'confirmations' via config
      incentivesContracts,
      transactionHelper,
      confirmationTimeout,
      signer,
      logger,
    );

    return [evalQueue, submitQueue, confirmQueue];
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
        confirmQueue: this.confirmQueue.size,
        confirmRetryQueue: this.confirmQueue.retryQueue.length,
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

  private getGasFeeConfig(config: SubmitterWorkerData): GasFeeConfig {
    return {
      gasPriceAdjustmentFactor: config.gasPriceAdjustmentFactor,
      maxAllowedGasPrice: config.maxAllowedGasPrice,
      maxFeePerGas: config.maxFeePerGas,
      maxPriorityFeeAdjustmentFactor: config.maxPriorityFeeAdjustmentFactor,
      maxAllowedPriorityFeePerGas: config.maxAllowedPriorityFeePerGas,
      priorityAdjustmentFactor: config.priorityAdjustmentFactor,
    };
  }

  /***************  Main Logic Loop.  ***************/

  async run(): Promise<void> {
    this.logger.debug(`Relaying messages (relayer: ${this.signer.address})`);

    // Initialize the queues
    await this.transactionHelper.init();
    await this.evalQueue.init();
    await this.submitQueue.init();
    await this.confirmQueue.init();

    // Start listener.
    await this.listenForOrders();

    while (true) {
      const evalOrders = await this.processNewOrdersQueue();

      await this.evalQueue.addOrders(...evalOrders);
      await this.evalQueue.processOrders();

      const [newSubmitOrders, ,] = this.evalQueue.getFinishedOrders();
      await this.submitQueue.addOrders(...newSubmitOrders);
      await this.submitQueue.processOrders();

      const [toConfirmSubmitOrders, ,] = this.submitQueue.getFinishedOrders();
      await this.confirmQueue.addOrders(...toConfirmSubmitOrders);
      await this.confirmQueue.processOrders();

      const [, unconfirmedSubmitOrders, rejectedSubmitOrders] =
        this.confirmQueue.getFinishedOrders();

      await this.handleUnconfirmedSubmitOrders(unconfirmedSubmitOrders);

      await this.handleRejectedSubmitOrders(rejectedSubmitOrders);

      await wait(this.config.processingInterval);
    }
  }

  private async handleUnconfirmedSubmitOrders(
    unconfirmedSubmitOrders: SubmitOrderResult[],
  ): Promise<void> {
    for (const unconfirmedOrder of unconfirmedSubmitOrders) {
      if (unconfirmedOrder.resubmit) {
        const requeueCount = unconfirmedOrder.requeueCount ?? 0;
        if (requeueCount >= this.config.maxTries - 1) {
          const orderDescription = {
            originalTxHash: unconfirmedOrder.tx.hash,
            replaceTxHash: unconfirmedOrder.replaceTx?.hash,
            resubmit: unconfirmedOrder.resubmit,
            requeueCount: requeueCount,
          };

          this.logger.warn(
            orderDescription,
            `Transaction confirmation failure. Maximum number of requeues reached. Dropping message.`,
          );
          continue;
        }

        const requeueOrder: SubmitOrder = {
          amb: unconfirmedOrder.amb,
          messageIdentifier: unconfirmedOrder.messageIdentifier,
          message: unconfirmedOrder.message,
          messageCtx: unconfirmedOrder.messageCtx,
          gasLimit: unconfirmedOrder.gasLimit,
          requeueCount: requeueCount + 1,
        };
        await this.submitQueue.addOrders(requeueOrder);
      }
    }
  }

  private async handleRejectedSubmitOrders(
    rejectedSubmitOrders: SubmitOrderResult[],
  ): Promise<void> {
    for (const rejectedOrder of rejectedSubmitOrders) {
      await this.cancelTransaction(rejectedOrder.tx);
    }
  }

  // This function does not return until the transaction of the given nonce is mined!
  private async cancelTransaction(baseTx: ContractTransaction): Promise<void> {
    const cancelTxNonce = baseTx.nonce;
    if (cancelTxNonce == undefined) {
      // This point should never be reached.
      //TODO log warn?
      return;
    }

    for (let i = 0; i < this.config.maxTries; i++) {
      // NOTE: cannot use the 'transactionHelper' for querying of the transaction nonce, as the
      // helper takes into account the 'pending' transactions.
      const latestNonce = await this.signer.getTransactionCount('latest');

      if (latestNonce > cancelTxNonce) {
        return;
      }

      try {
        const tx = await this.signer.sendTransaction({
          nonce: cancelTxNonce,
          to: constants.AddressZero,
          data: '0x',
          ...this.transactionHelper.getIncreasedFeeDataForTransaction(baseTx),
        });

        await this.provider.waitForTransaction(
          tx.hash,
          1, //TODO confirmations,
          this.config.confirmationTimeout,
        );

        // Transaction cancelled
        return;
      } catch {
        // continue
      }
    }

    this.isStalled = true;
    while (true) {
      this.logger.warn(
        { nonce: cancelTxNonce },
        `Submitter stalled. Waiting until pending transaction is resolved.`,
      );

      await wait(this.config.confirmationTimeout);

      // NOTE: cannot use the 'transactionHelper' for querying of the transaction nonce, as the
      // helper takes into account the 'pending' transactions.
      const latestNonce = await this.signer.getTransactionCount('latest');

      if (latestNonce > cancelTxNonce) {
        this.logger.info(
          { nonce: cancelTxNonce },
          `Submitter resumed after stall recovery.`,
        );
        this.isStalled = false;
        return;
      }
    }
  }

  /**
   * Subscribe to the Store to listen for relevant payloads to submit.
   */
  private async listenForOrders(): Promise<void> {
    const listenToChannel = Store.getChannel('submit', this.chainId);
    this.logger.info(`Listing for messages to submit on ${listenToChannel}`);

    await this.store.on(listenToChannel, (message: AmbPayload) => {
      void this.addSubmitOrder(
        message.amb,
        message.messageIdentifier,
        message.message,
        message.messageCtx ?? '',
        !!message.priority, // eval priority => undefined = false.
      );
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
      `Submit order received ${messageIdentifier} ${
        priority ? '(priority)' : ''
      }`,
    );
    if (priority) {
      // Push directly into the submit queue
      await this.submitQueue.addOrders({
        amb,
        messageIdentifier,
        message,
        messageCtx,
        gasLimit: undefined, //TODO, allow this to be set? (Some chains might fail with 'undefined')
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
        this.submitQueue.size -
        this.confirmQueue.size,
    );
  }
}

void new SubmitterWorker().run();
