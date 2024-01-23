import { BigNumber, ContractTransaction, BytesLike } from 'ethers';

export interface Order {
  amb: string;
  messageIdentifier: string;
  message: BytesLike;
  messageCtx: BytesLike;
}

export interface EvalOrder extends Order {}

export interface SubmitOrder extends Order {
  gasLimit: number | undefined;
  requeueCount?: number;
}

export interface SubmitOrderResult extends SubmitOrder {
  tx: ContractTransaction;
  replaceTx?: ContractTransaction;
  resubmit?: boolean;
}

export interface NewOrder<OrderType> {
  order: OrderType;
  processAt: number;
}

export interface GasFeeOverrides {
  gasPrice?: BigNumber;
  maxFeePerGas?: BigNumber;
  maxPriorityFeePerGas?: BigNumber;
}

export interface GasFeeConfig {
  gasPriceAdjustmentFactor: number | undefined;
  maxAllowedGasPrice: number | undefined;
  maxFeePerGas: number | undefined;
  maxPriorityFeeAdjustmentFactor: number | undefined;
  maxAllowedPriorityFeePerGas: number | undefined;
  priorityAdjustmentFactor: number | undefined;
}
