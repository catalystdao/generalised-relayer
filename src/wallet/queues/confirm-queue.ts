import { HandleOrderResult, ProcessingQueue } from 'src/processing-queue/processing-queue';
import { AbstractProvider, Wallet } from 'ethers6';
import pino from 'pino';
import { TransactionHelper } from '../transaction-helper';
import { ConfirmedTransaction, PendingTransaction } from '../wallet.types';
import { tryErrorToString } from 'src/common/utils';


export class ConfirmQueue extends ProcessingQueue<PendingTransaction, ConfirmedTransaction> {

    constructor(
        retryInterval: number,
        maxTries: number,
        private readonly confirmations: number,
        private readonly transactionHelper: TransactionHelper,
        private readonly confirmationTimeout: number,
        private readonly provider: AbstractProvider,
        private readonly wallet: Wallet,
        private readonly logger: pino.Logger,
    ) {
        super(
            retryInterval,
            maxTries,
            1, // Confirm transactions one at a time
        );

        if (this.confirmations == 0) {
            throw new Error(`'confirmations' may not be set to 0.`);
        }
    }

    protected override async onOrderInit(order: PendingTransaction): Promise<void> {
        order.txReplacement = undefined;
        order.confirmationError = undefined;
    }

    protected async handleOrder(
        order: PendingTransaction,
        retryCount: number,
    ): Promise<HandleOrderResult<ConfirmedTransaction> | null> {
        // If it's the first time the order is processed, just wait for it
        if (retryCount == 0) {
            const transactionReceipt = order.tx.wait(
                this.confirmations,
                this.confirmationTimeout,
            ).then((receipt) => {
                if (receipt == null) {
                    throw new Error('Receipt is \'null\' after waiting for transaction');   // This should never happen if confirmations > 0
                }
                return {
                    ...order,
                    txReceipt: receipt,
                }
            });

            return { result: transactionReceipt };
        }

        // Reprice the order if it hasn't been repriced
        if (!order.txReplacement) {
            // Reprice the order
            const originalTx = order.tx;

            await this.transactionHelper.updateFeeData();

            const increasedFeeConfig =
                this.transactionHelper.getIncreasedFeeDataForTransaction(originalTx);

            order.txReplacement = await this.wallet.sendTransaction({
                type: originalTx.type,
                to: originalTx.to,
                nonce: originalTx.nonce,
                gasLimit: originalTx.gasLimit,
                data: originalTx.data,
                value: originalTx.value,
                ...increasedFeeConfig,
            });
        }

        // Wait for either the original or the replace transaction to fulfill
        const originalTxReceipt = order.tx.wait(
            this.confirmations,
            this.confirmationTimeout,
        ).then((txReceipt) => ({ tx: order.tx, txReceipt }));

        const replaceTxReceipt = order.txReplacement!.wait(
            this.confirmations,
            this.confirmationTimeout,
        ).then((txReceipt) => ({ tx: order.txReplacement!, txReceipt }));

        const confirmationPromise = Promise.any([
            originalTxReceipt,
            replaceTxReceipt,
        ]).then(
            (result) => {
                if (result.txReceipt == null) {
                    throw new Error('Receipt is \'null\' after waiting for transaction');   // This should never happen if confirmations > 0
                }
                return {
                    ...order,
                    tx: result.tx,  // ! May not be the same as 'order.tx' (may be 'order.replaceTx')
                    txReceipt: result.txReceipt,
                }
            },
            (aggregateError) => {
                // If both the original/replace tx promises reject, throw the error of the replace tx.
                throw aggregateError.errors?.[1];
            },
        );

        return { result: confirmationPromise };
    }

    protected async handleFailedOrder(
        order: PendingTransaction,
        retryCount: number,
        error: any,
    ): Promise<boolean> {
        if (retryCount == 0) {
            // ! This logic only runs if the tx has **not** been repriced.
            return this.handleFailedOriginalOrder(order, retryCount, error);
        } else {
            return this.handleFailedRepricedOrder(order, retryCount, error);
        }
    }

    private async handleFailedOriginalOrder(
        order: PendingTransaction,
        retryCount: number,
        error: any,
    ): Promise<boolean> {

        const errorDescription = {
            txHash: order.tx.hash,
            error: tryErrorToString(error),
            try: retryCount + 1
        };

        // If tx timeouts, retry the order. This will cause `handleOrder` to reprice the tx.
        if (error.code === 'TIMEOUT') {
            this.logger.info(
                errorDescription,
                `Error on transaction confirmation: TIMEOUT. Transaction will be sped up.`,
            );
            return true;
        }

        // Unknown error on confirmation.
        this.logger.warn(
            errorDescription,
            `Error on transaction confirmation.`,
        );
        order.confirmationError = error;
        return false; // Do not retry order confirmation
    }

    private async handleFailedRepricedOrder(
        order: PendingTransaction,
        retryCount: number,
        error: any,
    ): Promise<boolean> {

        const errorDescription = {
            txHash: order.tx.hash,
            repricedTxHash: order.txReplacement?.hash,
            error: tryErrorToString(error),
            try: retryCount + 1
        };

        // If tx timeouts, keep waiting.
        if (error.code === 'TIMEOUT') {
            this.logger.info(
                errorDescription,
                `Error on transaction confirmation: TIMEOUT. Keep waiting if possible.`,
            );
            return true;
        }

        // If tx errors with 'REPLACEMENT_UNDERPRICED', retry the order, as the original tx may still resolve.
        if (error.code === 'REPLACEMENT_UNDERPRICED') {
            this.logger.warn(
                errorDescription,
                `Error on repriced transaction confirmation: REPLACEMENT_UNDERPRICED. Keep waiting until original tx is rejected.`,
            );
            return true;
        }

        // Unknown error on confirmation, keep waiting
        this.logger.warn(
            errorDescription,
            `Error on repriced transaction confirmation. Keep waiting if possible.`,
        );
        return true;
    }

    protected override async onOrderCompletion(
        order: PendingTransaction,
        success: boolean,
        result: null,
        retryCount: number,
    ): Promise<void> {
        const orderDescription = {
            txHash: order.tx.hash,
            repricedTxHash: order.txReplacement?.hash,
            try: retryCount + 1,
        };

        if (success) {
            this.logger.debug(orderDescription, `Transaction confirmed.`);
        } else {
            this.logger.error(orderDescription, `Transaction not confirmed.`);
        }
    }
}
