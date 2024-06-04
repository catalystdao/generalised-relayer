import { TransactionRequest, TransactionReceipt, TransactionResponse } from "ethers6";



// Port Channels Types
// ************************************************************************************************

export const WALLET_WORKER_CRASHED_MESSAGE_ID = -1;

export interface WalletPortData {
    chainId: string;
    messageId: number;
    message: WalletMessage;
}

export interface WalletServiceRoutingData {
    portId: number;
    messageId: number;
    message: WalletMessage;
}

export enum WalletMessageType {
    TransactionRequest,
    TransactionRequestResponse,
    GetFeeData,
    FeeData,
    WalletCrashed,
}

export type WalletMessage = WalletTransactionRequestMessage
    | WalletTransactionRequestResponseMessage
    | WalletGetFeeDataMessage
    | WalletFeeDataMessage
    | WalletCrashedMessage;


//TODO add 'priority'
export interface WalletTransactionRequestMessage<T = any> {
    type: WalletMessageType.TransactionRequest,
    txRequest: TransactionRequest;
    metadata: T;
    options?: WalletTransactionOptions;
}

export interface WalletTransactionRequestResponseMessage<T = any> {
    type: WalletMessageType.TransactionRequestResponse,
    txRequest: TransactionRequest;
    metadata: T;
    tx?: TransactionResponse;
    txReceipt?: TransactionReceipt;
    submissionError?: any;
    confirmationError?: any;
}

export interface WalletGetFeeDataMessage {
    type: WalletMessageType.GetFeeData,
    priority: boolean,
}

export interface WalletFeeDataMessage {
    type: WalletMessageType.FeeData,
    priority: boolean,
    gasPrice?: bigint;
    maxFeePerGas?: bigint;
    maxPriorityFeePerGas?: bigint;
}

export interface WalletCrashedMessage {
    type: WalletMessageType.WalletCrashed,
}



// Processing Types
// ************************************************************************************************
export interface WalletTransactionOptions {
    retryOnNonceConfirmationError?: boolean;    // Default: true, NOTE: this will cause the transaction to be executed out of order
    deadline?: number;                          // Default: undefined (i.e. no deadline)
}

export interface WalletTransactionRequest<T = any> {
    portId: number;
    messageId: number;
    txRequest: TransactionRequest;
    metadata: T;
    options: WalletTransactionOptions;
    requeueCount: number;
    submissionError?: any;
}

export interface PendingTransaction<T = any> extends WalletTransactionRequest<T> {
    tx: TransactionResponse;
    txReplacement?: TransactionResponse;
    confirmationError?: any;
}

export interface ConfirmedTransaction<T = any> extends WalletTransactionRequest<T> {
    tx: TransactionResponse;
    txReceipt: TransactionReceipt;
}



// Configuration Types
// ************************************************************************************************

export interface GasFeeOverrides {
    gasPrice?: bigint;
    maxFeePerGas?: bigint;
    maxPriorityFeePerGas?: bigint;
}

export interface GasFeeConfig {
    gasPriceAdjustmentFactor?: number;
    maxAllowedGasPrice?: bigint;
    maxFeePerGas?: bigint;
    maxPriorityFeeAdjustmentFactor?: number;
    maxAllowedPriorityFeePerGas?: bigint;
    priorityAdjustmentFactor?: number;
}

export interface BalanceConfig {
    lowBalanceWarning: bigint | undefined;
    balanceUpdateInterval: number;
}