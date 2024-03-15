import { BytesLike } from 'ethers6';

export interface Order {
  amb: string;
  messageIdentifier: string;
  message: BytesLike;
  messageCtx: BytesLike;
}

export interface EvalOrder extends Order {
  priority: boolean;
}

export interface SubmitOrder extends Order {
  gasLimit: number | undefined;
  requeueCount?: number;
}

export interface NewOrder<OrderType> {
  order: OrderType;
  processAt: number;
}

export interface GasFeeOverrides {
  gasPrice?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
}

export interface GasFeeConfig {
  gasPriceAdjustmentFactor?: number;
  maxAllowedGasPrice?: number | string;
  maxFeePerGas?: number | string;
  maxPriorityFeeAdjustmentFactor?: number;
  maxAllowedPriorityFeePerGas?: number | string;
  priorityAdjustmentFactor?: number;
}

export interface BalanceConfig {
  lowBalanceWarning: number | undefined;
  balanceUpdateInterval: number;
}
