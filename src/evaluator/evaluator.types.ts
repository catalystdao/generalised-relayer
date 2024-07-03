import { LoggerOptions } from "pino";
import { GasEstimateComponents } from "src/resolvers/resolver";
import { MessagePort } from "worker_threads";



// Constants
// ************************************************************************************************

export const EVALUATOR_DEFAULT_UNREWARDED_DELIVERY_GAS = 0n;
export const EVALUATOR_DEFAULT_VERIFICATION_DELIVERY_GAS = 0n;
export const EVALUATOR_DEFAULT_MIN_DELIVERY_REWARD = 0;
export const EVALUATOR_DEFAULT_RELATIVE_MIN_DELIVERY_REWARD = 0;
export const EVALUATOR_DEFAULT_UNREWARDED_ACK_GAS = 0n;
export const EVALUATOR_DEFAULT_VERIFICATION_ACK_GAS = 0n;
export const EVALUATOR_DEFAULT_MIN_ACK_REWARD = 0;
export const EVALUATOR_DEFAULT_RELATIVE_MIN_ACK_REWARD = 0;
export const EVALUATOR_DEFAULT_PROFITABILITY_FACTOR = 1;



// Port Channels Types
// ************************************************************************************************
export interface EvaluatorGetPortMessage {
    messageId: number;
}

export interface EvaluatorGetPortResponse {
    messageId: number;
    port: MessagePort;
}

export interface EvaluatorPortData {
    messageId: number;
    message: EvaluatorMessage;
}

export enum EvaluatorMessageType {
    EvaluateDelivery,
    EvaluateDeliveryResponse,
    EvaluateAck,
    EvaluateAckResponse,
    EmptyResponse,
}

export type EvaluatorMessage = EvaluateDeliveryMessage
    | EvaluateDeliveryResponseMessage
    | EvaluateAckMessage
    | EvaluateAckResponseMessage
    | EmptyResponseMessage;


export interface EvaluateDeliveryMessage {
    type: EvaluatorMessageType.EvaluateDelivery;
    chainId: string;
    messageIdentifier: string;
    gasEstimateComponents: GasEstimateComponents;
    value: bigint;
}

export interface EvaluateDeliveryResponseMessage {
    type: EvaluatorMessageType.EvaluateDeliveryResponse;
    chainId: string;
    messageIdentifier: string;
    evaluation: {
        maxGasDelivery: number;
        maxGasAck: number;
        gasEstimate: bigint;
        observedGasEstimate: bigint;
        additionalFeeEstimate: bigint;
        destinationGasPrice: bigint;
        value: bigint;
        sourceGasPrice: bigint;
        deliveryCost: bigint;
        deliveryReward: bigint;
        maxAckLoss: bigint;
        deliveryFiatCost: number;
        deliveryFiatReward: number;
        securedDeliveryFiatReward: number;
        profitabilityFactor: number;
        securedDeliveryFiatProfit: number;
        securedDeliveryRelativeProfit: number;
        minDeliveryReward: number;
        relativeMinDeliveryReward: number;
        relayDelivery: boolean;
    } | null;
}

export interface EvaluateAckMessage {
    type: EvaluatorMessageType.EvaluateAck;
    chainId: string;
    messageIdentifier: string;
    gasEstimateComponents: GasEstimateComponents;
    value: bigint;
}

export interface EvaluateAckResponseMessage {
    type: EvaluatorMessageType.EvaluateAckResponse;
    chainId: string;
    messageIdentifier: string;
    evaluation: {
        maxGasDelivery: number;
        maxGasAck: number;
        gasEstimate: bigint;
        observedGasEstimate: bigint;
        additionalFeeEstimate: bigint;
        sourceGasPrice: bigint;
        ackCost: bigint;
        ackReward: bigint;
        profitabilityFactor: number;
        ackFiatProfit: number;
        ackRelativeProfit: number;
        minAckReward: number;
        relativeMinAckReward: number;
        deliveryCost: bigint;
        deliveryReward: bigint;
        relayAckForDeliveryBounty: boolean;
        relayAck: boolean;
    } | null;
}

export interface EmptyResponseMessage {
    type: EvaluatorMessageType.EmptyResponse;
}



// Config and Worker Types
// ************************************************************************************************

export interface EvaluationConfig {

    unrewardedDeliveryGas: bigint;
    verificationDeliveryGas: bigint;
    minDeliveryReward: number;
    relativeMinDeliveryReward: number,

    unrewardedAckGas: bigint;
    verificationAckGas: bigint;
    minAckReward: number;
    relativeMinAckReward: number;

    profitabilityFactor: number;    
}

export interface EvaluatorWorkerData {
    evaluationConfigs: Record<string, EvaluationConfig>;
    pricingPort: MessagePort;
    walletPort: MessagePort;
    loggerOptions: LoggerOptions;
}
