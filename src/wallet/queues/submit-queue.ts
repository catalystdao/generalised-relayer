import { TransactionRequest, Wallet } from "ethers6";
import pino from "pino";
import { HandleOrderResult, ProcessingQueue } from "src/processing-queue/processing-queue";
import { PendingTransaction, WalletTransactionRequest } from "../wallet.types";
import { TransactionHelper } from "../transaction-helper";
import { tryErrorToString } from "src/common/utils";

export class SubmitQueue extends ProcessingQueue<WalletTransactionRequest, PendingTransaction> {

    constructor(
        retryInterval: number,
        maxTries: number,
        private readonly transactionHelper: TransactionHelper,
        private readonly signer: Wallet,
        private readonly logger: pino.Logger
    ) {
        super(
            retryInterval,
            maxTries,
            1, // Send transactions one at a time to ensure the order is maintained //TODO will this cause performance problems?
        );
    }

    protected override async onProcessOrders(): Promise<void> {
        await this.transactionHelper.updateFeeData();
        await this.transactionHelper.runBalanceCheck();
    }

    protected async handleOrder(
        order: WalletTransactionRequest,
        _retryCount: number
    ): Promise<HandleOrderResult<PendingTransaction> | null> {

        const txDeadline = order.options.deadline ?? Infinity;
        if (Date.now() > txDeadline) {
            throw new Error('Transaction submission deadline exceeded.');
        }

        const request: TransactionRequest = {
            ...order.txRequest,

            // Set overrides
            nonce: this.transactionHelper.getTransactionNonce(),
            ...this.transactionHelper.getFeeDataForTransaction()
        }

        const tx = await this.signer.sendTransaction(request);

        this.transactionHelper.increaseTransactionNonce();

        return { result: { ...order, tx } };
    }

    protected async handleFailedOrder(order: WalletTransactionRequest, retryCount: number, error: any): Promise<boolean> {

        const errorDescription = {
            transactionRequest: order.txRequest,
            error: tryErrorToString(error),
            try: retryCount + 1
        };

        if (typeof error.message == 'string') {
            if (error.message == 'Transaction submission deadline exceeded.') {
                this.logger.warn(
                    errorDescription,
                    'Transaction submission deadline exceeded.'
                );

                order.submissionError = error;
                return false;   // Do not retry submission
            }
        }

        if (
            error.code === 'NONCE_EXPIRED' ||
            error.code === 'REPLACEMENT_UNDERPRICED' ||
            error.error?.message.includes('invalid sequence') //TODO is this dangerous? (any contract may include that error)
        ) {
            await this.transactionHelper.updateTransactionNonce();
            this.logger.warn(errorDescription, `Invalid nonce on transaction submission. Retrying if possible.`);
            return true;
        }

        this.logger.warn(errorDescription, `Error on transaction submission.`);

        order.submissionError = error;
        return false;

    }

    protected override async onOrderCompletion(
        order: WalletTransactionRequest,
        success: boolean,
        result: PendingTransaction | null,
        retryCount: number
    ): Promise<void> {

        const orderDescription = {
            transactionRequest: order.txRequest,
            metadata: order.metadata,
            txHash: result?.tx.hash,
            try: retryCount + 1
        };

        if (success) {
            if (result != null) {
                this.logger.debug(
                    orderDescription,
                    `Successful transaction processing: transaction submitted.`,
                );
            } else {
                this.logger.debug(
                    orderDescription,
                    `Successful transaction processing: transaction not submitted.`,
                );
            }
        } else {
            this.logger.error(
                orderDescription,
                `Unsuccessful transaction processing.`,
            );
        }
    }
}
