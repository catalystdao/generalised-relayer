import { BytesLike, TransactionReceipt, TransactionResponse } from 'ethers6';

export interface Order {
    amb: string;
    messageIdentifier: string;
    message: BytesLike;
    messageCtx: BytesLike;
    incentivesPayload?: BytesLike;
}

export interface EvalOrder extends Order {
    priority: boolean;
}

export interface SubmitOrder extends Order {
    isDelivery: boolean;
    priority: boolean;
    gasLimit: bigint | undefined;
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


export interface BountyEvaluationConfig {
    minDeliveryReward: number;
    relativeMinDeliveryReward: number,
    minAckReward: number;
    relativeMinAckReward: number;
}