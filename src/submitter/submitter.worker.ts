import { BigNumber, BytesLike, Wallet } from 'ethers';
import { StaticJsonRpcProvider } from '@ethersproject/providers';
import pino, { LoggerOptions } from 'pino';
import { Store } from 'src/store/store.lib';
import { ChainConfig } from 'src/config/config.service';
import { IncentivizedMessageEscrow } from 'src/contracts';
import { IncentivizedMessageEscrow__factory } from 'src/contracts/factories/IncentivizedMessageEscrow__factory';
import { workerData } from 'worker_threads';
import { AmbPayload } from 'src/store/types/store.types';
import { STATUS_LOG_INTERVAL } from 'src/logger/logger.service';
import { EvalOrder, GasFeeConfig, NewOrder } from './submitter.types';
import { EvalQueue } from './queues/eval-queue';
import { SubmitQueue } from './queues/submit-queue';
import { wait } from 'src/common/utils';

const MAX_GAS_PRICE_ADJUSTMENT_FACTOR = 5;

class SubmitterWorker {
  readonly store: Store;
  readonly logger: pino.Logger;

  readonly chainConfig: ChainConfig;

  readonly provider: StaticJsonRpcProvider;
  readonly signer: Wallet;

  readonly newOrdersQueue: NewOrder<EvalOrder>[] = [];
  readonly evalQueue: EvalQueue;
  readonly submitQueue: SubmitQueue;

  readonly newOrdersDelay: number;
  readonly processingInterval: number;
  readonly maxPendingTransactions: number;

  constructor() {
    this.chainConfig = workerData.chainConfig;

    this.newOrdersDelay = workerData.workerConfig.newOrdersDelay ?? 0;
    this.processingInterval = workerData.workerConfig.processingInterval;
    this.maxPendingTransactions =
      workerData.workerConfig.maxPendingTransactions ?? Infinity;

    this.store = new Store(this.chainConfig.chainId);
    this.logger = this.initializeLogger(
      this.chainConfig.chainId,
      workerData.loggerOptions,
    );
    this.provider = new StaticJsonRpcProvider(this.chainConfig.rpc);
    this.signer = new Wallet(workerData.relayerPrivateKey, this.provider);

    [this.evalQueue, this.submitQueue] = this.initializeQueues(
      workerData.workerConfig.retryInterval,
      workerData.workerConfig.maxTries,
      this.store,
      this.loadIncentivesContracts(workerData.incentivesAddresses),
      this.chainConfig.chainId,
      workerData.workerConfig.gasLimitBuffer,
      this.loadGasFeeConfig(),
      workerData.workerConfig.transactionTimeout,
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
    gasFeeConfig: GasFeeConfig,
    transactionTimeout: number,
    signer: Wallet,
    logger: pino.Logger,
  ): [EvalQueue, SubmitQueue] {
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
      gasFeeConfig,
      transactionTimeout,
      signer,
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

  private loadGasFeeConfig(): GasFeeConfig {
    const {
      gasPriceAdjustmentFactor,
      maxAllowedGasPrice,
      maxFeePerGas,
      maxPriorityFeeAdjustmentFactor,
      maxAllowedPriorityFeePerGas,
    } = workerData.workerConfig;

    if (
      gasPriceAdjustmentFactor != undefined &&
      gasPriceAdjustmentFactor > MAX_GAS_PRICE_ADJUSTMENT_FACTOR
    ) {
      throw new Error(
        `Failed to load gas fee configuration. 'gasPriceAdjustmentFactor' is larger than the allowed (${MAX_GAS_PRICE_ADJUSTMENT_FACTOR})`,
      );
    }

    if (
      maxPriorityFeeAdjustmentFactor != undefined &&
      maxPriorityFeeAdjustmentFactor > MAX_GAS_PRICE_ADJUSTMENT_FACTOR
    ) {
      throw new Error(
        `Failed to load gas fee configuration. 'maxPriorityFeeAdjustmentFactor' is larger than the allowed (${MAX_GAS_PRICE_ADJUSTMENT_FACTOR})`,
      );
    }

    return {
      gasPriceAdjustmentFactor: gasPriceAdjustmentFactor,
      maxAllowedGasPrice:
        maxAllowedGasPrice != undefined
          ? BigNumber.from(maxAllowedGasPrice)
          : undefined,
      maxFeePerGas:
        maxFeePerGas != undefined ? BigNumber.from(maxFeePerGas) : undefined,
      maxPriorityFeeAdjustmentFactor: maxPriorityFeeAdjustmentFactor,
      maxAllowedPriorityFeePerGas:
        maxAllowedPriorityFeePerGas != undefined
          ? BigNumber.from(maxAllowedPriorityFeePerGas)
          : undefined,
    };
  }

  /***************  Main Logic Loop.  ***************/

  async run(): Promise<void> {
    this.logger.debug(`Relaying messages (relayer: ${this.signer.address})`);

    // Initialize the queues
    await this.evalQueue.init();
    await this.submitQueue.init();

    // Start listener.
    this.listenForOrders();

    while (true) {
      const evalOrders = await this.processNewOrdersQueue();

      await this.evalQueue.addOrders(...evalOrders);
      await this.evalQueue.processOrders();

      const newUnderwriteOrders = this.evalQueue.getCompletedOrders();
      await this.submitQueue.addOrders(...newUnderwriteOrders);
      await this.submitQueue.processOrders();

      // If it is time for any of the reties in the queue to be moved
      // towards the action queues do that.
      await this.evalQueue.processRetries();
      await this.submitQueue.processRetries();

      await wait(this.processingInterval);
    }
  }

  /**
   * Subscribe to the Store to listen for relevant payloads to submit.
   */
  private listenForOrders(): void {
    const listenToChannel = Store.getChannel(
      'submit',
      this.chainConfig.chainId,
    );
    this.logger.info(`Listing for messages to submit on ${listenToChannel}`);

    this.store.on(listenToChannel, (message: AmbPayload) => {
      this.addSubmitOrder(
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
      this.submitQueue.addOrders({
        amb,
        messageIdentifier,
        message,
        messageCtx,
        gasLimit: undefined, //TODO, allow this to be set? (Some chains might fail with 'undefined')
      });
    } else {
      // Push into the evaluation queue
      this.newOrdersQueue.push({
        processAt: Date.now() + this.newOrdersDelay,
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
      this.maxPendingTransactions - this.evalQueue.size - this.submitQueue.size,
    );
  }
}

new SubmitterWorker().run();
