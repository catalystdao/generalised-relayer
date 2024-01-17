import { HandleOrderResult, ProcessingQueue } from './processing-queue';
import {
  GasFeeConfig,
  GasFeeOverrides,
  SubmitOrder,
  SubmitOrderResult,
} from '../submitter.types';
import { BigNumber, Wallet } from 'ethers';
import pino from 'pino';
import { IncentivizedMessageEscrow } from 'src/contracts';
import { FeeData } from '@ethersproject/providers';
import { hexZeroPad } from 'ethers/lib/utils';

export class SubmitQueue extends ProcessingQueue<
  SubmitOrder,
  SubmitOrderResult
> {
  private relayerAddress: string;
  private transactionCount: number;
  private feeData: FeeData | undefined;

  constructor(
    readonly retryInterval: number,
    readonly maxTries: number,
    private readonly incentivesContracts: Map<
      string,
      IncentivizedMessageEscrow
    >,
    private readonly gasFeeConfig: GasFeeConfig,
    private readonly transactionTimeout: number,
    private readonly signer: Wallet,
    private readonly logger: pino.Logger,
  ) {
    super(retryInterval, maxTries);
  }

  async init(): Promise<void> {
    this.relayerAddress = hexZeroPad(await this.signer.getAddress(), 32);

    await this.updateTransactionCount();
    await this.updateFeeData();
  }

  protected async handleOrder(
    order: SubmitOrder,
    retryCount: number,
  ): Promise<HandleOrderResult<SubmitOrderResult> | null> {
    // Simulate the packet submission as a static call. Skip if it's the first submission try,
    // as in that case the packet 'evaluation' will have been executed shortly before.
    const contract = this.incentivesContracts.get(order.amb)!; //TODO handle undefined case

    if (retryCount > 0) {
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

    this.logger.info(
      { messageIdentifier: order.messageIdentifier, txHash: tx.hash },
      `Submitted message.`,
    );

    const timingOutTxPromise: Promise<SubmitOrderResult> = Promise.race([
      tx.wait().then((receipt: any) => {
        if (receipt == null) {
          throw new Error('Submit tx TIMEOUT');
        }
        return { txHash: receipt.hash, ...order };
      }),

      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject('Submit tx TIMEOUT'), this.transactionTimeout),
      ),
    ]);

    return { result: timingOutTxPromise };
  }

  protected async handleFailedOrder(
    order: SubmitOrder,
    retryCount: number,
    error: any,
  ): Promise<boolean> {
    const errorDescription = {
      messageIdentifier: order.messageIdentifier,
      error,
      try: retryCount + 1,
    };

    if (error.code === 'CALL_EXCEPTION') {
      //TODO improve error filtering?
      this.logger.info(
        errorDescription,
        `Error on message submission: CALL_EXCEPTION. It has likely been relayed by another relayer. Dropping message.`,
      );
      return false; // Do not retry eval
    }

    this.logger.warn(errorDescription, `Error on message submission`);

    if (
      error.code === 'NONCE_EXPIRED' ||
      error.code === 'REPLACEMENT_UNDERPRICED' ||
      error.error?.message.includes('invalid sequence')
    ) {
      await this.updateTransactionCount();
    }

    return true;
  }

  protected async onOrderCompletion(
    order: SubmitOrder,
    success: boolean,
    result: SubmitOrderResult | null,
    retryCount: number,
  ): Promise<void> {
    const orderDescription = {
      messageIdentifier: order.messageIdentifier,
      txHash: result?.txHash,
      try: retryCount + 1,
    };

    if (success) {
      if (result?.gasLimit != 0) {
        this.logger.debug(
          orderDescription,
          `Successful message processing: message submitted.`,
        );
      } else {
        this.logger.debug(
          orderDescription,
          `Successful message processing: message not submitted.`,
        );
      }
    } else {
      this.logger.error(orderDescription, `Unsuccessful message processing.`);
    }
  }

  // Helpers

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

  private async updateFeeData(): Promise<void> {
    try {
      this.feeData = await this.signer.provider.getFeeData();
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
}
