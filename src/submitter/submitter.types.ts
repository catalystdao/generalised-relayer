import { BytesLike, TransactionReceipt, TransactionRequest, TransactionResponse } from 'ethers6';

export interface Order {
    amb: string;
    messageIdentifier: string;
    message: BytesLike;
    messageCtx: BytesLike;
    incentivesPayload?: BytesLike;
}

export interface EvalOrder extends Order {
    priority: boolean;
    evaluationDeadline: number;
    retryEvaluation?: boolean;
}

export interface SubmitOrder extends Order {
    isDelivery: boolean;
    priority: boolean;
    transactionRequest: TransactionRequest;
    requeueCount?: number;
}

export interface SubmitOrderResult extends SubmitOrder {
    tx: TransactionResponse;
    txReceipt: TransactionReceipt;
}

export interface PendingOrder<OrderType> {
    order: OrderType;
    processAt: number;
}
