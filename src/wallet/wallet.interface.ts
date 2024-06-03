import { TransactionReceipt, TransactionRequest, TransactionResponse } from 'ethers6';
import { MessagePort } from 'worker_threads';
import { WalletTransactionOptions, WalletTransactionRequestMessage, WalletTransactionRequestResponseMessage } from './wallet.types';
import { WALLET_WORKER_CRASHED_MESSAGE_ID } from './wallet.service';

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
            const listener = (data: any) => {
                if (data.messageId === messageId) {
                    this.port.off("message", listener);

                    const walletResponse = data as WalletTransactionRequestResponseMessage<T>;

                    const result = {
                        txRequest: walletResponse.txRequest,
                        metadata: walletResponse.metadata,
                        tx: walletResponse.tx,
                        txReceipt: walletResponse.txReceipt,
                        submissionError: data.submissionError,
                        confirmationError: data.confirmationError
                    };
                    resolve(result);
                } else if (data.messageId === WALLET_WORKER_CRASHED_MESSAGE_ID) {
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
