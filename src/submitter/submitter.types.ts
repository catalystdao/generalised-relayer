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
    evaluationDeadline: number;
    retryEvaluation?: boolean;
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

export interface PendingOrder<OrderType> {
    order: OrderType;
    processAt: number;
}


export interface BountyEvaluationConfig {
    evaluationRetryInterval: number,
    maxEvaluationDuration: number,
    unrewardedDeliveryGas: bigint;
    minDeliveryReward: number;
    relativeMinDeliveryReward: number,
    unrewardedAckGas: bigint;
    minAckReward: number;
    relativeMinAckReward: number;
    profitabilityFactor: number;
}