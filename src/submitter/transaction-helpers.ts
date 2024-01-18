import { FeeData } from '@ethersproject/providers';
import { BigNumber, Wallet } from 'ethers';
import { GasFeeConfig, GasFeeOverrides } from './submitter.types';
import pino from 'pino';

export class TransactionHelper {
  private transactionCount: number;
  private feeData: FeeData | undefined;

  constructor(
    private readonly retryInterval: number,
    private readonly gasFeeConfig: GasFeeConfig,
    private readonly signer: Wallet,
    private readonly logger: pino.Logger,
  ) {}

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

  getFeeDataForTransaction(): GasFeeOverrides {
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
