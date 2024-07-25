import { FeeData, TransactionReceipt, TransactionRequest, TransactionResponse } from 'ethers6';
import { MessagePort } from 'worker_threads';
import { WALLET_WORKER_CRASHED_MESSAGE_ID, WalletFeeDataMessage, WalletGetFeeDataMessage, WalletMessageType, WalletPortData, WalletTransactionOptions, WalletTransactionRequestMessage, WalletTransactionRequestResponseMessage } from './wallet.types';

export interface TransactionResult<T = any> {
    txRequest: TransactionRequest;
    metadata?: T;
    tx?: TransactionResponse;
    txReceipt?: TransactionReceipt;
    submissionError?: any;
    confirmationError?: any;
}

export class WalletInterface {
    private portMessageId = 0;

    constructor(private readonly port: MessagePort) {}

    private getNextPortMessageId(): number {
        return this.portMessageId++;
    }

    async submitTransaction<T>(
        chainId: string,
        transaction: TransactionRequest,
        metadata?: T,
        options?: WalletTransactionOptions
    ): Promise<TransactionResult<T>> {

        const messageId = this.getNextPortMessageId();

        const resultPromise = new Promise<TransactionResult<T>>(resolve => {
            const listener = (data: WalletPortData) => {
                if (data.messageId === messageId) {
                    this.port.off("message", listener);

                    const walletResponse = data.message as WalletTransactionRequestResponseMessage<T>;

                    const result = {
                        txRequest: walletResponse.txRequest,
                        metadata: walletResponse.metadata,
                        tx: walletResponse.tx,
                        txReceipt: walletResponse.txReceipt,
                        submissionError: walletResponse.submissionError,
                        confirmationError: walletResponse.confirmationError
                    };
                    resolve(result);
                } else if (
                    data.messageId === WALLET_WORKER_CRASHED_MESSAGE_ID
                    && data.chainId == chainId
                ) {
                    this.port.off("message", listener);

                    const result = {
                        txRequest: transaction,
                        metadata,
                        submissionError: new Error('Wallet crashed.'),      //TODO use a custom error type?
                        confirmationError: new Error('Wallet crashed.'),    //TODO use a custom error type?
                    };
                    resolve(result);                    
                }
            };
            this.port.on("message", listener);

            const message: WalletTransactionRequestMessage = {
                type: WalletMessageType.TransactionRequest,
                txRequest: transaction,
                metadata,
                options
            };

            const portData: WalletPortData = {
                chainId,
                messageId,
                message,
            }
            this.port.postMessage(portData);
        });

        return resultPromise;
    }

    async getFeeData(
        chainId: string,
        priority?: boolean,
    ): Promise<FeeData> {

        const messageId = this.getNextPortMessageId();

        const resultPromise = new Promise<FeeData>(resolve => {
            const listener = (data: WalletPortData) => {
                if (data.messageId === messageId) {
                    this.port.off("message", listener);

                    const walletResponse = data.message as WalletFeeDataMessage;

                    const result = {
                        gasPrice: walletResponse.gasPrice,
                        maxFeePerGas: walletResponse.maxFeePerGas,
                        maxPriorityFeePerGas: walletResponse.maxPriorityFeePerGas,
                    } as FeeData;
                    resolve(result);
                } else if (
                    data.messageId === WALLET_WORKER_CRASHED_MESSAGE_ID
                    && data.chainId == chainId
                ) {
                    this.port.off("message", listener);

                    const result = {} as FeeData;
                    resolve(result);                    
                }
            };
            this.port.on("message", listener);

            const message: WalletGetFeeDataMessage = {
                type: WalletMessageType.GetFeeData,
                priority: priority ?? false,
            };

            const portData: WalletPortData = {
                chainId,
                messageId,
                message,
            }
            this.port.postMessage(portData);
        });

        return resultPromise;
    }
}
