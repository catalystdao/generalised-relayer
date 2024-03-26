import { BytesLike, TransactionReceipt, TransactionResponse } from 'ethers6';

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

export interface SubmitOrderResult extends SubmitOrder {
  tx: TransactionResponse;
  txReceipt: TransactionReceipt;
}

export interface NewOrder<OrderType> {
  order: OrderType;
  processAt: number;
}
