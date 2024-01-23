import { ContractTransaction } from 'ethers';
import { BigNumber, BigNumberish, BytesLike } from 'ethers';

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
  gasPrice?: BigNumberish;
  maxFeePerGas?: BigNumberish;
  maxPriorityFeePerGas?: BigNumberish;
}

export interface GasFeeConfig {
  gasPriceAdjustmentFactor: number | undefined;
  maxAllowedGasPrice: BigNumber | undefined;
  maxFeePerGas: BigNumber | undefined;
  maxPriorityFeeAdjustmentFactor: number | undefined;
  maxAllowedPriorityFeePerGas: BigNumber | undefined;
  priorityAdjustmentFactor: number | undefined;
}
