import {
    HandleOrderResult,
    ProcessingQueue,
} from '../../processing-queue/processing-queue';
import { SubmitOrder, SubmitOrderResult } from '../submitter.types';
import { TransactionRequest, zeroPadValue } from 'ethers6';
import pino from 'pino';
import { tryErrorToString } from 'src/common/utils';
import { IncentivizedMessageEscrow } from 'src/contracts';
import { Store } from 'src/store/store.lib';
import { WalletInterface } from 'src/wallet/wallet.interface';

export class SubmitQueue extends ProcessingQueue<
    SubmitOrder,
    SubmitOrderResult
> {
    readonly relayerAddress: string;

    constructor(
        retryInterval: number,
        maxTries: number,
        private readonly store: Store,
        private readonly incentivesContracts: Map<string, IncentivizedMessageEscrow>,
        relayerAddress: string,
        private readonly chainId: string,
        private readonly wallet: WalletInterface,
        private readonly logger: pino.Logger,
    ) {
        super(retryInterval, maxTries);
        this.relayerAddress = zeroPadValue(relayerAddress, 32);
    }

    protected async handleOrder(
        order: SubmitOrder,
        retryCount: number,
    ): Promise<HandleOrderResult<SubmitOrderResult> | null> {
        this.logger.debug(
            { messageIdentifier: order.messageIdentifier },
            `Handling submit order`,
        );

        return null;

        // Simulate the packet submission as a static call. Skip if it's the first submission try,
        // as in that case the packet 'evaluation' will have been executed shortly before.
        const contract = this.incentivesContracts.get(order.amb)!; //TODO handle undefined case

        if (retryCount > 0 || (order.requeueCount ?? 0) > 0) {
            await contract.processPacket.staticCall(
                order.messageCtx,
                order.message,
                this.relayerAddress,
                {
                    gasLimit: order.gasLimit,
                },
            );
        }

        // Execute the relay transaction if the static call did not fail.
        const txData = contract.interface.encodeFunctionData("processPacket", [
            order.messageCtx,
            order.message,
            this.relayerAddress,
        ]);

        const txRequest: TransactionRequest = {
            to: await contract.getAddress(),
            data: txData,
            gasLimit: order.gasLimit,
        };

        const txPromise = this.wallet.submitTransaction(
            this.chainId,
            txRequest,
            order,
        ).then((transactionResult): SubmitOrderResult => {
            if (transactionResult.submissionError) {
                throw transactionResult.submissionError;    //TODO wrap in a 'SubmissionError' type?
            }
            if (transactionResult.confirmationError) {
                throw transactionResult.confirmationError;    //TODO wrap in a 'ConfirmationError' type?
            }

            if (transactionResult.tx == undefined) {
                // This case should never be reached (if tx == undefined, a 'submissionError' should be returned).
                throw new Error('No transaction returned on wallet transaction submission result.');
            }
            if (transactionResult.txReceipt == undefined) {
                // This case should never be reached (if txReceipt == undefined, a 'confirmationError' should be returned).
                throw new Error('No transaction receipt returned on wallet transaction submission result.');
            }

            const order = transactionResult.metadata as SubmitOrder;

            return {
                ...order,
                tx: transactionResult.tx,
                txReceipt: transactionResult.txReceipt
            };
        });

        return { result: txPromise };
    }

    protected async handleFailedOrder(
        order: SubmitOrder,
        retryCount: number,
        error: any,
    ): Promise<boolean> {
        const errorDescription = {
            messageIdentifier: order.messageIdentifier,
            error: tryErrorToString(error),
            try: retryCount + 1,
        };

        if (error.code === 'CALL_EXCEPTION') {
            //TODO improve error filtering?
            this.logger.info(
                errorDescription,
                `Error on message submission: CALL_EXCEPTION. It has likely been relayed by another relayer. Dropping message.`,
            );
            return false; // Do not retry eval
        }

        this.logger.warn(errorDescription, `Error on message submission. Retrying if possible.`);
        return true;
    }

    protected override async onOrderCompletion(
        order: SubmitOrder,
        success: boolean,
        result: SubmitOrderResult | null,
        retryCount: number,
    ): Promise<void> {
        const orderDescription = {
            messageIdentifier: order.messageIdentifier,
            txHash: result?.tx.hash,
            try: retryCount + 1,
        };

        if (success) {
            if (result != null) {
                this.logger.debug(
                    orderDescription,
                    `Successful submit order: message submitted.`,
                );

                void this.registerSubmissionCost(order, result.txReceipt.gasUsed);
            } else {
                this.logger.debug(
                    orderDescription,
                    `Successful submit order: message not submitted.`,
                );
            }
        } else {
            this.logger.error(orderDescription, `Unsuccessful submit order.`);

            if (order.priority) {
                this.logger.warn(
                    {
                        ...orderDescription,
                        priority: order.priority
                    },
                    `Priority submit order failed.`
                );
            }
        }
    }

    private async registerSubmissionCost(
        order: SubmitOrder,
        gasUsed: bigint,
    ): Promise<void> {
        // Currently the 'ack' submission cost is not registered.
        if (order.isDelivery) {
            void this.store.registerDeliveryCost({
                messageIdentifier: order.messageIdentifier,
                deliveryGasCost: gasUsed
            });
        }
    }
}
