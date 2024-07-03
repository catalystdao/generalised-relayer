import {
    HandleOrderResult,
    ProcessingQueue,
} from '../../processing-queue/processing-queue';
import { EvalOrder, SubmitOrder } from '../submitter.types';
import pino from 'pino';
import { Store } from 'src/store/store.lib';
import { Bounty } from 'src/store/types/store.types';
import { BountyStatus } from 'src/store/types/bounty.enum';
import { IncentivizedMockEscrow__factory } from 'src/contracts';
import { tryErrorToString } from 'src/common/utils';
import { TransactionRequest, zeroPadValue } from 'ethers6';
import { Resolver, GasEstimateComponents } from 'src/resolvers/resolver';
import { IncentivizedMockEscrowInterface } from 'src/contracts/IncentivizedMockEscrow';
import { EvaluatorInterface } from 'src/evaluator/evaluator.interface';

export class EvalQueue extends ProcessingQueue<EvalOrder, SubmitOrder> {
    readonly paddedRelayerAddress: string;
    private readonly escrowInterface: IncentivizedMockEscrowInterface;

    constructor(
        retryInterval: number,
        maxTries: number,
        private readonly relayerAddress: string,
        private readonly resolver: Resolver,
        private readonly store: Store,
        private readonly incentivesContracts: Map<string, string>,
        private readonly packetCosts: Map<string, bigint>,
        private readonly chainId: string,
        private readonly evaluator: EvaluatorInterface,
        private readonly logger: pino.Logger,
    ) {
        super(retryInterval, maxTries);
        this.paddedRelayerAddress = zeroPadValue(relayerAddress, 32);
        this.escrowInterface = IncentivizedMockEscrow__factory.createInterface();
    }

    protected async handleOrder(
        order: EvalOrder,
        _retryCount: number,
    ): Promise<HandleOrderResult<SubmitOrder> | null> {
        this.logger.debug(
            { messageIdentifier: order.messageIdentifier },
            `Handling submitter eval order.`,
        );

        const bounty = await this.queryBountyInfo(order.messageIdentifier);
        if (bounty === null || bounty === undefined) {
            throw Error(
                `Bounty of message not found on evaluation (message ${order.messageIdentifier})`,
            );
        }

        // Check if the message has already been submitted.
        const isDelivery = bounty.fromChainId != this.chainId;
        if (isDelivery) {
            // Source to Destination
            if (bounty.status >= BountyStatus.MessageDelivered) {
                this.logger.info(
                    { messageIdentifier: bounty.messageIdentifier },
                    `Bounty evaluation (source to destination). Message already delivered.`,
                );
                return null; // Do not relay packet
            }
        } else {
            // Destination to Source
            if (bounty.status >= BountyStatus.BountyClaimed) {
                this.logger.info(
                    { messageIdentifier: bounty.messageIdentifier },
                    `Bounty evaluation (destination to source). Ack already delivered.`,
                );
                return null; // Do not relay packet
            }
        }

        const contractAddress = this.incentivesContracts.get(order.amb)!; //TODO handle undefined case

        const transactionData = this.escrowInterface.encodeFunctionData("processPacket", [
            order.messageCtx,
            order.message,
            this.paddedRelayerAddress,
        ]);

        const value = isDelivery
            ? this.packetCosts.get(order.amb) ?? 0n
            : 0n;

        const transactionRequest: TransactionRequest = {
            from: this.relayerAddress,
            to: contractAddress,
            data: transactionData,
            value,
        }

        const gasEstimateComponents = await this.resolver.estimateGas(transactionRequest);

        const submitRelay = await this.evaluateRelaySubmission(
            gasEstimateComponents,
            value,
            bounty,
            order
        );

        if (submitRelay) {
            // Move the order to the submit queue
            transactionRequest.gasLimit = gasEstimateComponents.gasEstimate;
            return { result: { ...order, transactionRequest, isDelivery } };
        } else {
            // Request the order to be retried in the future.
            order.retryEvaluation = true;

            return null;
        }
    }

    protected async handleFailedOrder(
        order: EvalOrder,
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
                `Failed to evaluate message: CALL_EXCEPTION. It has likely been relayed by another relayer. Dropping message.`,
            );
            return false; // Do not retry eval
        }

        this.logger.warn(errorDescription, `Error on order eval.`);

        return true;
    }

    protected override async onOrderCompletion(
        order: EvalOrder,
        success: boolean,
        result: SubmitOrder | null,
        retryCount: number,
    ): Promise<void> {
        const orderDescription = {
            messageIdentifier: order.messageIdentifier,
            try: retryCount + 1,
        };

        if (success) {
            if (result != null) {
                this.logger.info(
                    orderDescription,
                    `Successful bounty evaluation: submit order.`,
                );
            } else {
                this.logger.info(
                    orderDescription,
                    `Successful bounty evaluation: do not submit order.`,
                );
            }
        } else {
            this.logger.error(orderDescription, `Unsuccessful bounty evaluation.`);

            if (order.priority) {
                this.logger.warn(
                    {
                        ...orderDescription,
                        priority: order.priority
                    },
                    `Priority submit order evaluation failed.`
                );
            }
        }
    }

    /**
     * TODO: What is the point of this helper?
     */
    private async queryBountyInfo(
        messageIdentifier: string,
    ): Promise<Bounty | null> {
        return this.store.getBounty(messageIdentifier);
    }

    private async evaluateRelaySubmission(
        gasEstimateComponents: GasEstimateComponents,
        value: bigint,
        bounty: Bounty,
        order: EvalOrder,
    ): Promise<boolean> {
        const messageIdentifier = order.messageIdentifier;

        const isDelivery = bounty.fromChainId != this.chainId;

        if (isDelivery) {
            // Source to Destination
            if (order.priority) {
                this.logger.debug(
                    {
                        messageIdentifier,
                        maxGasDelivery: bounty.maxGasDelivery,
                        gasEstimate: gasEstimateComponents.gasEstimate.toString(),
                        additionalFeeEstimate: gasEstimateComponents.additionalFeeEstimate.toString(),
                        priority: true,
                    },
                    `Bounty evaluation (source to destination): submit delivery (priority order).`,
                );

                return true;
            }

            return this.evaluateDeliverySubmission(
                bounty.messageIdentifier,
                gasEstimateComponents,
                value,
            );
        } else {
            // Destination to Source
            if (order.priority) {
                this.logger.debug(
                    {
                        messageIdentifier,
                        maxGasAck: bounty.maxGasAck,
                        gasEstimate: gasEstimateComponents.gasEstimate.toString(),
                        additionalFeeEstimate: gasEstimateComponents.additionalFeeEstimate.toString(),
                        priority: true,
                    },
                    `Bounty evaluation (destination to source): submit ack (priority order).`,
                );

                return true;
            }

            return this.evaluateAckSubmission(
                bounty.messageIdentifier,
                gasEstimateComponents,
                value
            );
        }
    }

    private async evaluateDeliverySubmission(
        messageIdentifier: string,
        gasEstimateComponents: GasEstimateComponents,
        value: bigint,
    ): Promise<boolean> {

        const result = await this.evaluator.evaluateDelivery(
            this.chainId,
            messageIdentifier,
            gasEstimateComponents,
            value,
        );

        if (result.evaluation == null) {
            throw new Error('Failed to evaluate delivery submission: evaluation result is null.');
        }

        this.logger.info(
            {
                messageIdentifier,
                ...result.evaluation,
            },
            `Bounty evaluation (source to destination).`,
        );

        return result.evaluation.relayDelivery;
    }

    private async evaluateAckSubmission(
        messageIdentifier: string,
        gasEstimateComponents: GasEstimateComponents,
        value: bigint,
    ): Promise<boolean> {

        const result = await this.evaluator.evaluateAck(
            this.chainId,
            messageIdentifier,
            gasEstimateComponents,
            value,
        );

        if (result.evaluation == null) {
            throw new Error('Failed to evaluate ack submission: evaluation result is null.');
        }

        this.logger.info(
            {
                messageIdentifier,
                ...result.evaluation,
            },
            `Bounty evaluation (destination to source).`,
        );

        return result.evaluation.relayAck;
    }

}
