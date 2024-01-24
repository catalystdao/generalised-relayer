import { FeeData } from '@ethersproject/providers';
import { BigNumber, ContractTransaction, Wallet } from 'ethers';
import { GasFeeConfig, GasFeeOverrides } from './submitter.types';
import pino from 'pino';

const DECIMAL_BASE = 10000;
const DECIMAL_BASE_BIG_NUMBER = BigNumber.from(DECIMAL_BASE);

export const DEFAULT_PRIORITY_ADJUSTMENT_FACTOR = 1.1;
export const MAX_GAS_PRICE_ADJUSTMENT_FACTOR = 5;

export class TransactionHelper {
  private transactionCount: number;
  private feeData: FeeData | undefined;

  private priorityAdjustmentFactor: BigNumber;

  // Config for legacy transactions
  private gasPriceAdjustmentFactor: BigNumber | undefined;
  private maxAllowedGasPrice: BigNumber | undefined;

  // Config for EIP 1559 transactions
  private maxFeePerGas: BigNumber | undefined;
  private maxPriorityFeeAdjustmentFactor: BigNumber | undefined;
  private maxAllowedPriorityFeePerGas: BigNumber | undefined;

  constructor(
    gasFeeConfig: GasFeeConfig,
    private readonly retryInterval: number,
    private readonly signer: Wallet,
    private readonly logger: pino.Logger,
  ) {
    this.loadGasFeeConfig(gasFeeConfig);
  }

  private loadGasFeeConfig(config: GasFeeConfig): void {
    const {
      gasPriceAdjustmentFactor,
      maxAllowedGasPrice,
      maxFeePerGas,
      maxPriorityFeeAdjustmentFactor,
      maxAllowedPriorityFeePerGas,
      priorityAdjustmentFactor,
    } = config;

    // Config for legacy transactions
    if (gasPriceAdjustmentFactor != undefined) {
      if (gasPriceAdjustmentFactor > MAX_GAS_PRICE_ADJUSTMENT_FACTOR) {
        throw new Error(
          `Failed to load gas fee configuration. 'gasPriceAdjustmentFactor' is larger than the allowed (${MAX_GAS_PRICE_ADJUSTMENT_FACTOR})`,
        );
      }

      this.gasPriceAdjustmentFactor = BigNumber.from(
        gasPriceAdjustmentFactor * DECIMAL_BASE,
      );
    }

    if (maxAllowedGasPrice != undefined) {
      this.maxAllowedGasPrice = BigNumber.from(maxAllowedGasPrice);
    }

    // Config for EIP 1559 transactions
    if (maxPriorityFeeAdjustmentFactor != undefined) {
      if (maxPriorityFeeAdjustmentFactor > MAX_GAS_PRICE_ADJUSTMENT_FACTOR) {
        throw new Error(
          `Failed to load gas fee configuration. 'maxPriorityFeeAdjustmentFactor' is larger than the allowed (${MAX_GAS_PRICE_ADJUSTMENT_FACTOR})`,
        );
      }

      this.maxPriorityFeeAdjustmentFactor = BigNumber.from(
        maxPriorityFeeAdjustmentFactor * DECIMAL_BASE,
      );
    }

    if (maxFeePerGas != undefined) {
      this.maxFeePerGas = BigNumber.from(maxFeePerGas);
    }

    if (maxAllowedPriorityFeePerGas != undefined) {
      this.maxAllowedPriorityFeePerGas = BigNumber.from(
        maxAllowedPriorityFeePerGas,
      );
    }

    // Priority config
    if (priorityAdjustmentFactor != undefined) {
      if (
        priorityAdjustmentFactor > MAX_GAS_PRICE_ADJUSTMENT_FACTOR ||
        priorityAdjustmentFactor < 1
      ) {
        throw new Error(
          `Failed to load gas fee configuration. 'priorityAdjustmentFactor' is larger than the allowed (${MAX_GAS_PRICE_ADJUSTMENT_FACTOR}) or less than 1.`,
        );
      }

      this.priorityAdjustmentFactor = BigNumber.from(
        priorityAdjustmentFactor * DECIMAL_BASE,
      );
    } else {
      this.logger.info(
        `Priority adjustment factor unset. Defaulting to ${DEFAULT_PRIORITY_ADJUSTMENT_FACTOR}`,
      );

      this.priorityAdjustmentFactor = BigNumber.from(
        DEFAULT_PRIORITY_ADJUSTMENT_FACTOR * DECIMAL_BASE,
      );
    }
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
      let maxFeePerGas = this.maxFeePerGas;

      // Adjust the 'maxPriorityFeePerGas' by the adjustment factor
      let maxPriorityFeePerGas;
      if (this.maxPriorityFeeAdjustmentFactor != undefined) {
        maxPriorityFeePerGas = queriedMaxPriorityFeePerGas
          .mul(this.maxPriorityFeeAdjustmentFactor)
          .div(DECIMAL_BASE_BIG_NUMBER);
      }

      // Apply the max allowed 'maxPriorityFeePerGas'
      if (
        maxPriorityFeePerGas != undefined &&
        this.maxAllowedPriorityFeePerGas != undefined &&
        this.maxAllowedPriorityFeePerGas.lt(maxPriorityFeePerGas)
      ) {
        maxPriorityFeePerGas = this.maxAllowedPriorityFeePerGas;
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
      if (this.gasPriceAdjustmentFactor != undefined) {
        gasPrice = queriedGasPrice
          .mul(this.gasPriceAdjustmentFactor)
          .div(DECIMAL_BASE_BIG_NUMBER);
      }

      // Apply the max allowed 'gasPrice'
      if (
        gasPrice != undefined &&
        this.maxAllowedGasPrice != undefined &&
        this.maxAllowedGasPrice.lt(gasPrice)
      ) {
        gasPrice = this.maxAllowedGasPrice;
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

  getIncreasedFeeDataForTransaction(
    originalTx: ContractTransaction,
  ): GasFeeOverrides {
    const priorityFees = this.getFeeDataForTransaction(true);

    const gasPrice = this.getLargestFee(
      originalTx.gasPrice,
      priorityFees.gasPrice,
    );
    const maxFeePerGas = this.getLargestFee(
      originalTx.maxFeePerGas,
      priorityFees.maxFeePerGas,
    );
    const maxPriorityFeePerGas = this.getLargestFee(
      originalTx.maxPriorityFeePerGas,
      priorityFees.maxPriorityFeePerGas,
    );

    if (
      gasPrice == undefined &&
      maxFeePerGas == undefined &&
      maxPriorityFeePerGas == undefined
    ) {
      this.logger.warn(
        { tx: originalTx.hash },
        `Failed to compute increased fee data for tx. All fee values returned 'undefined'.`,
      );
    }

    return {
      gasPrice,
      maxFeePerGas,
      maxPriorityFeePerGas,
    };
  }

  // If 'previousFee' exists, return the largest of:
  // - previousFee * priorityAdjustmentFactor
  // - priorityFee
  private getLargestFee(
    previousFee: BigNumber | undefined,
    priorityFee: BigNumber | undefined,
  ): BigNumber | undefined {
    if (previousFee != undefined) {
      const increasedPreviousFee = previousFee
        .mul(this.priorityAdjustmentFactor)
        .div(DECIMAL_BASE_BIG_NUMBER);

      if (priorityFee == undefined || increasedPreviousFee > priorityFee) {
        return increasedPreviousFee;
      } else {
        return priorityFee;
      }
    }

    return undefined;
  }
}
