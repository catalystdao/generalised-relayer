import { BigNumber, BigNumberish, BytesLike, Wallet } from 'ethers';
import { hexZeroPad } from 'ethers/lib/utils';
import { FeeData, StaticJsonRpcProvider } from '@ethersproject/providers';
import pino from 'pino';
import { Store } from 'src/store/store.lib';
import { ChainConfig } from 'src/config/config.service';
import { IncentivizedMessageEscrow } from 'src/contracts';
import { IncentivizedMessageEscrow__factory } from 'src/contracts/factories/IncentivizedMessageEscrow__factory';
import { Bounty } from 'src/store/types/store.types';
import { workerData } from 'worker_threads';
import { AmbPayload } from 'src/store/types/store.types';
import { BountyStatus } from 'src/store/types/bounty.enum';
import { STATUS_LOG_INTERVAL } from 'src/logger/logger.service';

interface Order {
  amb: string;
  messageIdentifier: string;
  message: BytesLike;
  messageCtx: BytesLike;
}

interface NewOrder extends Order {
  processAt: number;
}

interface EvalOrder extends Order {
  retryCount: number;
}

interface SubmitOrder extends Order {
  retryCount: number;
  gasLimit: number | undefined;
}

interface RetryOrder<T> {
  order: T;
  retryAtTimestamp: number;
}

//TODO keep track of unconfirmed transactions and don't allow them to exceed a predefined number?

interface GasFeeOverrides {
  gasPrice?: BigNumberish;
  maxFeePerGas?: BigNumberish;
  maxPriorityFeePerGas?: BigNumberish;
}

interface GasFeeConfig {
  gasPriceAdjustmentFactor: number | undefined;
  maxAllowedGasPrice: BigNumber | undefined;
  maxFeePerGas: BigNumber | undefined;
  maxPriorityFeeAdjustmentFactor: number | undefined;
  maxAllowedPriorityFeePerGas: BigNumber | undefined;
}

const MAX_GAS_PRICE_ADJUSTMENT_FACTOR = 5;

class SubmitterWorker {
  readonly logger: pino.Logger;

  readonly chainConfig: ChainConfig;

  readonly provider: StaticJsonRpcProvider;
  readonly signer: Wallet;

  readonly incentivesContracts: Map<string, IncentivizedMessageEscrow>;

  private relayerAddress: string;

  readonly store: Store;

  readonly newOrdersQueue: NewOrder[] = [];

  readonly evalQueue: EvalOrder[] = [];
  readonly evalRetryQueue: RetryOrder<EvalOrder>[] = [];

  readonly submitQueue: SubmitOrder[] = [];
  readonly submitRetryQueue: RetryOrder<SubmitOrder>[] = [];

  readonly newOrdersDelay: number;
  readonly retryInterval: number;
  readonly processingInterval: number;
  readonly maxTries: number;
  readonly transactionTimeout: number;

  readonly gasFeeConfig: GasFeeConfig;
  private feeData: FeeData | undefined;

  readonly maxPendingTransactions: number;
  private pendingTransactions = 0;

  readonly gasLimitBuffer: Record<string, number>;

  private transactionCount: number;

  constructor() {
    this.chainConfig = workerData.chainConfig;

    this.store = new Store(this.chainConfig.chainId);

    this.provider = new StaticJsonRpcProvider(this.chainConfig.rpc);
    this.signer = new Wallet(workerData.relayerPrivateKey, this.provider);

    this.incentivesContracts = this.loadIncentivesContracts(
      workerData.incentivesAddresses,
    );

    this.newOrdersDelay = workerData.workerConfig.newOrdersDelay ?? 0;
    this.retryInterval = workerData.workerConfig.retryInterval;
    this.processingInterval = workerData.workerConfig.processingInterval;
    this.maxTries = workerData.workerConfig.maxTries;
    this.transactionTimeout = workerData.workerConfig.transactionTimeout;
    this.maxPendingTransactions =
      workerData.workerConfig.maxPendingTransactions ?? Infinity;
    this.gasLimitBuffer = workerData.workerConfig.gasLimitBuffer;

    this.gasFeeConfig = this.loadGasFeeConfig();

    this.logger = pino(workerData.loggerOptions).child({
      worker: 'submitter',
      chain: this.chainConfig.chainId,
    });

    this.logger.info('Submitter worker started.');

    this.initiateIntervalStatusLog();
  }

  private initiateIntervalStatusLog(): void {
    const logStatus = () => {
      const status = {
        capacity: this.getSubmitterCapacity(),
        pendingTransactions: this.pendingTransactions,
        newOrdersQueue: this.newOrdersQueue.length,
        evalQueue: this.evalQueue.length,
        evalRetryQueue: this.evalRetryQueue.length,
        submitQueue: this.submitQueue.length,
        submitRetryQueue: this.submitRetryQueue.length,
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

  /**
   * Update the transaction count of the signer.
   */
  private async updateTransactionCount(): Promise<void> {
    let i = 1;
    while (true) {
      try {
        this.transactionCount =
          await this.signer.getTransactionCount('pending'); //TODO 'pending' may not be supported
        break;
      } catch (error) {
        // Continue trying indefinitely. If the transaction count is incorrect, no transaction will go through.
        this.logger.error(`Failed to update nonce for chain (try ${i}).`);
        await new Promise((r) => setTimeout(r, this.retryInterval));
      }

      i++;
    }
  }

  private async queryBountyInfo(
    messageIdentifier: string,
  ): Promise<Bounty | null> {
    return this.store.getBounty(messageIdentifier);
  }

  async run(): Promise<void> {
    this.relayerAddress = hexZeroPad(await this.signer.getAddress(), 32);

    await this.updateTransactionCount();

    this.logger.debug(`Relaying messages (relayer: ${this.relayerAddress})`);

    this.listenForOrders();

    while (true) {
      await this.processNewOrdersQueue();

      await this.processEvalQueue();
      await this.processSubmitQueue();

      await this.processEvalRetryQueue();
      await this.processSubmitRetryQueue();

      await new Promise((r) => setTimeout(r, this.processingInterval));
    }
  }

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

  private async evaluateBounty(order: EvalOrder): Promise<number> {
    const messageIdentifier = order.messageIdentifier;
    const bounty = await this.queryBountyInfo(messageIdentifier);
    if (bounty === null || bounty === undefined) {
      throw Error(
        `Bounty of message not found on evaluation (message ${messageIdentifier})`,
      );
    }

    // Check if the bounty has already been submitted
    const isDelivery = bounty.fromChainId != this.chainConfig.chainId;
    if (isDelivery) {
      // Source to Destination
      if (bounty.status >= BountyStatus.MessageDelivered) {
        this.logger.debug(
          `Bounty evaluation (source to destination) ${messageIdentifier}. Bounty already delivered.`,
        );
        return 0; // Do not relay packet
      }
    } else {
      // Destination to Source
      if (bounty.status >= BountyStatus.BountyClaimed) {
        this.logger.debug(
          `Bounty evaluation (destination to source) ${messageIdentifier}. Bounty already acked.`,
        );
        return 0; // Do not relay packet
      }
    }

    const contract = this.incentivesContracts.get(order.amb)!; //TODO handle undefined case
    const gasEstimation = await contract.estimateGas.processPacket(
      order.messageCtx,
      order.message,
      this.relayerAddress,
    );

    const gasLimitBuffer = this.getGasLimitBuffer(order.amb);

    if (isDelivery) {
      // Source to Destination
      const gasLimit = bounty.maxGasDelivery + gasLimitBuffer;

      this.logger.debug(
        `Bounty evaluation (source to destination) ${messageIdentifier}. Gas limit: ${gasLimit} (${bounty.maxGasDelivery
        } + buffer ${gasLimitBuffer}). Gas estimation ${gasEstimation.toNumber()}`,
      );

      if (BigNumber.from(gasLimit).lt(gasEstimation)) {
        return 0; // Do not relay packet
      }

      return gasLimit;
    } else {
      // Destination to Source
      const gasLimit = bounty.maxGasAck + gasLimitBuffer;

      this.logger.debug(
        `Bounty evaluation (destination to source) ${messageIdentifier}. Gas limit: ${gasLimit} (${bounty.maxGasAck
        } + buffer ${gasLimitBuffer}). Gas estimation ${gasEstimation.toNumber()}`,
      );

      if (BigNumber.from(gasLimit).lt(gasEstimation)) {
        return 0; // Do not relay packet
      }

      return gasLimit;
    }

    return 0; // Do not relay packet
  }

  private getGasLimitBuffer(amb: string): number {
    return this.gasLimitBuffer[amb] ?? this.gasLimitBuffer['default'] ?? 0;
  }

  private async processNewOrdersQueue(): Promise<void> {
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
      return {
        amb: newOrder.amb,
        messageIdentifier: newOrder.messageIdentifier,
        message: newOrder.message,
        messageCtx: newOrder.messageCtx,
        retryCount: 0,
      };
    });
    this.evalQueue.push(...ordersToEval);
  }

  private async processEvalQueue(): Promise<void> {
    for (const order of this.evalQueue) {
      try {
        const gasLimit = await this.evaluateBounty(order);

        if (gasLimit > 0) {
          // Move the order to the submit queue
          this.logger.debug(
            `Successful bounty evaluation for message ${order.messageIdentifier
            } (try ${order.retryCount + 1})`,
          );
          order.retryCount = 0; // Reset the retry count
          this.submitQueue.push({
            ...order,
            gasLimit,
          });
        } else {
          //TODO improve logging: e.g. bounty already delivered
          this.logger.info(
            `Bounty insufficient for message ${order.messageIdentifier
            }. Dropping message (try ${order.retryCount + 1}).`,
          );
        }
      } catch (error) {
        if (error.code === 'CALL_EXCEPTION') {
          //TODO improve error filtering?
          this.logger.info(
            `Failed to evaluate message ${order}: CALL_EXCEPTION. It has likely been relayed by another relayer. Dropping message (try ${order.retryCount + 1
            }).`,
          );
          continue;
        }

        // Retry logic
        order.retryCount += 1;
        this.logger.warn(
          error,
          `Failed to eval message ${order.messageIdentifier} (try ${order.retryCount})`,
        );
        if (order.retryCount >= this.maxTries) {
          // Discard the message
          this.logger.error(
            `Failed to eval message ${order.messageIdentifier}. Dropping message (try ${order.retryCount}).`,
          );
        } else {
          // Move the order to the 'retry' queue
          this.evalRetryQueue.push({
            order,
            retryAtTimestamp: Date.now() + this.retryInterval,
          });
        }
      }
    }

    // Clear the 'retry' queue
    this.evalQueue.length = 0;
  }

  private async processSubmitQueue(): Promise<void> {
    if (this.submitQueue.length > 0) await this.updateFeeData();

    for (const order of this.submitQueue) {
      try {
        // Simulate the packet submission as a static call. Skip if it's the first submission try,
        // as in that case the packet 'evaluation' will have been executed shortly before.
        const contract = this.incentivesContracts.get(order.amb)!; //TODO handle undefined case

        if (order.retryCount > 0) {
          await contract.callStatic.processPacket(
            order.messageCtx,
            order.message,
            this.relayerAddress,
            {
              gasLimit: order.gasLimit,
            },
          );
        }

        // Execute the relay transaction if the static call did not fail.
        const tx = await contract.processPacket(
          order.messageCtx,
          order.message,
          this.relayerAddress,
          {
            nonce: this.transactionCount,
            ...this.getFeeDataForTransaction(),
          },
        );

        this.registerPendingTransaction(tx.wait(), order);
        this.transactionCount++;

        this.logger.info(
          `Submitted message ${order.messageIdentifier} (hash: ${tx.hash} on block ${tx.blockNumber})`,
        );
      } catch (error) {
        if (error.code === 'CALL_EXCEPTION') {
          //TODO improve error filtering?
          this.logger.info(
            `Failed to submit message ${order.messageIdentifier
            }: CALL_EXCEPTION. It has likely been relayed by another relayer. Dropping message (try ${order.retryCount + 1
            }).`,
          );
          continue;
        } else if (
          error.code === 'NONCE_EXPIRED' ||
          error.code === 'REPLACEMENT_UNDERPRICED' ||
          error.error?.message.includes('invalid sequence')
        ) {
          await this.updateTransactionCount();
        }

        // Retry logic
        order.retryCount += 1;
        this.logger.warn(
          error,
          `Failed to submit message ${order.messageIdentifier} (try ${order.retryCount})`,
        );
        if (order.retryCount >= this.maxTries) {
          // Discard the message
          this.logger.error(
            `Failed to submit message ${order.messageIdentifier}. Dropping message (try ${order.retryCount}).`,
          );
        } else {
          // Move the order to the 'retry' queue
          this.submitRetryQueue.push({
            order,
            retryAtTimestamp: Date.now() + this.retryInterval,
          });
        }
      }
    }

    // Clear the 'submit' queue
    this.submitQueue.length = 0;
  }

  private async updateFeeData(): Promise<void> {
    try {
      this.feeData = await this.provider.getFeeData();
    } catch {
      // Continue with stale fee data.
    }
  }

  private getFeeDataForTransaction(): GasFeeOverrides {
    const queriedFeeData = this.feeData;
    if (queriedFeeData == undefined) {
      return {};
    }

    const queriedMaxPriorityFeePerGas = queriedFeeData.maxPriorityFeePerGas;
    if (queriedMaxPriorityFeePerGas != null) {
      // Set fee data for an EIP 1559 transactions
      const maxFeePerGas = this.gasFeeConfig.maxFeePerGas;

      // Adjust the 'maxPriorityFeePerGas' by the adjustment factor
      let maxPriorityFeePerGas;
      if (this.gasFeeConfig.maxPriorityFeeAdjustmentFactor != undefined) {
        maxPriorityFeePerGas = BigNumber.from(
          Math.floor(
            queriedMaxPriorityFeePerGas.toNumber() *
              this.gasFeeConfig.maxPriorityFeeAdjustmentFactor,
          ),
        );
      }

      // Apply the max allowed 'maxPriorityFeePerGas'
      if (
        maxPriorityFeePerGas != undefined &&
        this.gasFeeConfig.maxAllowedPriorityFeePerGas != undefined &&
        this.gasFeeConfig.maxAllowedPriorityFeePerGas.lt(maxPriorityFeePerGas)
      ) {
        maxPriorityFeePerGas = this.gasFeeConfig.maxAllowedPriorityFeePerGas;
      }

      return {
        maxFeePerGas,
        maxPriorityFeePerGas,
      };
    } else {
      // Set traditional gasPrice
      const queriedGasPrice = queriedFeeData.gasPrice;
      if (queriedGasPrice == null) return {};

      // Adjust the 'gasPrice' by the adjustment factor
      let gasPrice;
      if (this.gasFeeConfig.gasPriceAdjustmentFactor != undefined) {
        gasPrice = BigNumber.from(
          Math.floor(
            queriedGasPrice.toNumber() *
              this.gasFeeConfig.gasPriceAdjustmentFactor,
          ),
        );
      }

      // Apply the max allowed 'gasPrice'
      if (
        gasPrice != undefined &&
        this.gasFeeConfig.maxAllowedGasPrice != undefined &&
        this.gasFeeConfig.maxAllowedGasPrice.lt(gasPrice)
      ) {
        gasPrice = this.gasFeeConfig.maxAllowedGasPrice;
      }

      return {
        gasPrice,
      };
    }
  }

  private async processSubmitRetryQueue(): Promise<void> {
    // Get the number of elements to move from the `retry` to the `submit` queue. Note that the
    // `retry` queue elements are in chronological order.

    const nowTimestamp = Date.now();

    let i;
    for (i = 0; i < this.submitRetryQueue.length; i++) {
      const retryOrder = this.submitRetryQueue[i];
      if (retryOrder.retryAtTimestamp <= nowTimestamp) {
        this.submitQueue.push(retryOrder.order);
      } else {
        break;
      }
    }

    // Remove the elements to be retried from the `retry` queue
    this.submitRetryQueue.splice(0, i);
  }

  private async processEvalRetryQueue(): Promise<void> {
    // Get the number of elements to move from the `retry` to the `submit` queue. Note that the
    // `retry` queue elements are in chronological order.

    const nowTimestamp = Date.now();

    let i;
    for (i = 0; i < this.evalRetryQueue.length; i++) {
      const retryOrder = this.evalRetryQueue[i];
      if (retryOrder.retryAtTimestamp <= nowTimestamp) {
        this.evalQueue.push(retryOrder.order);
      } else {
        break;
      }
    }

    // Remove the elements to be retried from the `retry` queue
    this.evalRetryQueue.splice(0, i);
  }

  private registerPendingTransaction(
    promise: Promise<any>,
    order: SubmitOrder,
  ): void {
    this.pendingTransactions += 1;

    const timingOutPromise = Promise.race([
      promise,
      new Promise((resolve, reject) =>
        setTimeout(reject, this.transactionTimeout),
      ),
    ]);

    timingOutPromise.then(
      () => (this.pendingTransactions -= 1),
      () => {
        this.pendingTransactions -= 1;
        //TODO the following logic should be reused from the 'processSubmitQueue' function
        // Retry the transaction// Retry logic
        order.retryCount += 1;
        this.logger.warn(
          new Error('Transaction submission timed out.'),
          `Failed to submit message ${order.messageIdentifier} (try ${order.retryCount})`,
        );
        if (order.retryCount >= this.maxTries) {
          // Discard the message
          this.logger.error(
            `Failed to submit message ${order.messageIdentifier}. Dropping message (try ${order.retryCount}).`,
          );
        } else {
          // Move the order to the 'retry' queue
          this.submitRetryQueue.push({
            order,
            retryAtTimestamp: Date.now() + this.retryInterval,
          });
        }
      },
    );
  }

  private getSubmitterCapacity(): number {
    return Math.max(
      0,
      this.maxPendingTransactions -
        (this.pendingTransactions +
          this.evalQueue.length +
          this.evalRetryQueue.length +
          this.submitQueue.length +
          this.submitRetryQueue.length),
    );
  }

  private async addSubmitOrder(
    amb: string,
    messageIdentifier: string,
    message: BytesLike,
    messageCtx: BytesLike,
    priority: boolean,
  ) {
    this.logger.debug(
      `Submit order received ${messageIdentifier} ${priority ? '(priority)' : ''
      }`,
    );
    if (priority) {
      // Push directly into the submit queue
      this.submitQueue.push({
        amb,
        messageIdentifier,
        message,
        messageCtx,
        retryCount: 0,
        gasLimit: undefined, //TODO, allow this to be set? (Some chains might fail with 'undefined')
      });
    } else {
      // Push into the evaluation queue
      this.newOrdersQueue.push({
        amb,
        messageIdentifier,
        message,
        messageCtx,
        processAt: Date.now() + this.newOrdersDelay,
      });
    }
  }
}

new SubmitterWorker().run();
