import { TransactionReceipt, TransactionRequest, TransactionResponse } from 'ethers6';
import { MessagePort } from 'worker_threads';
import { WalletTransactionOptions, WalletTransactionRequestMessage, WalletTransactionRequestResponse } from './wallet.types';

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
        transaction: TransactionRequest,
        metadata?: T,
        options?: WalletTransactionOptions
    ): Promise<TransactionResult<T>> {

        const messageId = this.getNextPortMessageId();

        const resultPromise = new Promise<TransactionResult<T>>(resolve => {
            const listener = (data: WalletTransactionRequestResponse<T>) => {
                if (data.messageId == messageId) {
                    this.port.off("message", listener);

                    const result = {
                        txRequest: data.txRequest,
                        metadata: data.metadata,
                        tx: data.tx,
                        txReceipt: data.txReceipt,
                        submissionError: data.submissionError,
                        confirmationError: data.confirmationError
                    };
                    resolve(result);
                }
            };
            this.port.on("message", listener);

            const request: WalletTransactionRequestMessage = {
                messageId,
                txRequest: transaction,
                metadata,
                options
            };
            this.port.postMessage(request);
        });

        return resultPromise;
    }
}
