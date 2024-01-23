import { FeeData } from '@ethersproject/providers';
import { BigNumber, Wallet } from 'ethers';
import { GasFeeConfig, GasFeeOverrides } from './submitter.types';
import pino from 'pino';

const DECIMAL_BASE = 10000;
const DECIMAL_BASE_BIG_NUMBER = BigNumber.from(DECIMAL_BASE);

export const DEFAULT_PRIORITY_ADJUSTMENT_FACTOR = 1.1;

export class TransactionHelper {
  private transactionCount: number;
  private feeData: FeeData | undefined;
  private priorityAdjustmentFactor: BigNumber;

  constructor(
    private readonly retryInterval: number,
    private readonly gasFeeConfig: GasFeeConfig,
    private readonly signer: Wallet,
    private readonly logger: pino.Logger,
  ) {
    let priorityAdjustmentFactor = gasFeeConfig.priorityAdjustmentFactor;
    if (priorityAdjustmentFactor == undefined) {
      this.logger.info(
        `Priority adjustment factor unset. Defaulting to ${DEFAULT_PRIORITY_ADJUSTMENT_FACTOR}`,
      );
      priorityAdjustmentFactor = DEFAULT_PRIORITY_ADJUSTMENT_FACTOR;
    }

    this.priorityAdjustmentFactor = BigNumber.from(
      priorityAdjustmentFactor * DECIMAL_BASE,
    );
  }

  async init(): Promise<void> {
    await this.updateTransactionCount();
    await this.updateFeeData();
  }

  /**
   * Update the transaction count of the signer.
   */
  async updateTransactionCount(): Promise<void> {
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

  getTransactionCount(): number {
    return this.transactionCount;
  }

  increaseTransactionCount(): void {
    this.transactionCount++;
  }

  async updateFeeData(): Promise<void> {
    try {
      this.feeData = await this.signer.provider.getFeeData();
    } catch {
      // Continue with stale fee data.
    }
  }

  getFeeDataForTransaction(priority?: boolean): GasFeeOverrides {
    const queriedFeeData = this.feeData;
    if (queriedFeeData == undefined) {
      return {};
    }

    const queriedMaxPriorityFeePerGas = queriedFeeData.maxPriorityFeePerGas;
    if (queriedMaxPriorityFeePerGas != null) {
      // Set fee data for an EIP 1559 transactions
      let maxFeePerGas = this.gasFeeConfig.maxFeePerGas;

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

      if (priority) {
        maxFeePerGas = maxFeePerGas
          ?.mul(this.priorityAdjustmentFactor)
          .div(DECIMAL_BASE_BIG_NUMBER);

        maxPriorityFeePerGas = maxPriorityFeePerGas
          ?.mul(this.priorityAdjustmentFactor)
          .div(DECIMAL_BASE_BIG_NUMBER);
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

      if (priority) {
        gasPrice = gasPrice
          ?.mul(this.priorityAdjustmentFactor)
          .div(DECIMAL_BASE_BIG_NUMBER);
      }

      return {
        gasPrice,
      };
    }
  }
}
