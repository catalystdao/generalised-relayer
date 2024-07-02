import {
    HandleOrderResult,
    ProcessingQueue,
} from '../../processing-queue/processing-queue';
import { BountyEvaluationConfig, EvalOrder, SubmitOrder } from '../submitter.types';
import pino from 'pino';
import { Store } from 'src/store/store.lib';
import { Bounty } from 'src/store/types/store.types';
import { BountyStatus } from 'src/store/types/bounty.enum';
import { IncentivizedMockEscrow__factory } from 'src/contracts';
import { tryErrorToString } from 'src/common/utils';
import { AbstractProvider, BytesLike, MaxUint256, TransactionRequest, zeroPadValue } from 'ethers6';
import { ParsePayload, MessageContext } from 'src/payload/decode.payload';
import { PricingInterface } from 'src/pricing/pricing.interface';
import { WalletInterface } from 'src/wallet/wallet.interface';
import { Resolver, GasEstimateComponents } from 'src/resolvers/resolver';
import { IncentivizedMockEscrowInterface } from 'src/contracts/IncentivizedMockEscrow';

const DECIMAL_BASE = 10000;
const DECIMAL_BASE_BIG_INT = BigInt(DECIMAL_BASE);

export class EvalQueue extends ProcessingQueue<EvalOrder, SubmitOrder> {
    readonly paddedRelayerAddress: string;
    private readonly escrowInterface: IncentivizedMockEscrowInterface;

    private readonly profitabilityFactorBigInt: bigint;

    constructor(
        retryInterval: number,
        maxTries: number,
        private readonly relayerAddress: string,
        private readonly resolver: Resolver,
        private readonly store: Store,
        private readonly incentivesContracts: Map<string, string>,
        private readonly packetCosts: Map<string, bigint>,
        private readonly chainId: string,
        private readonly evaluationConfig: BountyEvaluationConfig,
        private readonly pricing: PricingInterface,
        private readonly provider: AbstractProvider,
        private readonly wallet: WalletInterface,
        private readonly logger: pino.Logger,
    ) {
        super(retryInterval, maxTries);
        this.paddedRelayerAddress = zeroPadValue(relayerAddress, 32);
        this.escrowInterface = IncentivizedMockEscrow__factory.createInterface();
        this.profitabilityFactorBigInt = BigInt(this.evaluationConfig.profitabilityFactor * DECIMAL_BASE);
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

            return this.evaluateDeliverySubmission(gasEstimateComponents, value, bounty);
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

            return this.evaluateAckSubmission(gasEstimateComponents, value, bounty, order.incentivesPayload);
        }
    }

    private async evaluateDeliverySubmission(
        gasEstimateComponents: GasEstimateComponents,
        value: bigint,
        bounty: Bounty
    ): Promise<boolean> {

        const {
            gasEstimate,
            observedGasEstimate,
            additionalFeeEstimate
        } = gasEstimateComponents;
        
        const destinationGasPrice = await this.getGasPrice(this.chainId);
        const sourceGasPrice = await this.getGasPrice(bounty.fromChainId);

        const deliveryCost = this.calcGasCost(              // ! In destination chain gas value
            gasEstimate,
            destinationGasPrice,
            additionalFeeEstimate + value
        );

        const deliveryReward = this.calcGasReward(          // ! In source chain gas value
            observedGasEstimate,
            this.evaluationConfig.unrewardedDeliveryGas,
            BigInt(bounty.maxGasDelivery),
            bounty.priceOfDeliveryGas
        );

        const maxAckLoss = this.calcMaxGasLoss(             // ! In source chain gas value
            sourceGasPrice,
            this.evaluationConfig.unrewardedAckGas,
            this.evaluationConfig.verificationAckGas,
            BigInt(bounty.maxGasAck),
            bounty.priceOfAckGas,
        );


        // Compute the cost and reward of the message delivery in Fiat and evaluate the message
        // delivery profit.
        const deliveryFiatCost = await this.getGasCostFiatPrice(
            deliveryCost,
            this.chainId
        );

        const adjustedDevlieryReward = deliveryReward * DECIMAL_BASE_BIG_INT
            / this.profitabilityFactorBigInt;

        const securedDeliveryReward = adjustedDevlieryReward + maxAckLoss;

        const securedDeliveryFiatReward = await this.getGasCostFiatPrice(
            securedDeliveryReward,
            bounty.fromChainId
        );

        // Compute the 'deliveryFiatReward' for logging purposes (i.e. without the 'maxAckLoss' factor)
        const securedRewardFactor = Number(
            ((deliveryReward + maxAckLoss) * DECIMAL_BASE_BIG_INT) / (deliveryReward)
        ) / DECIMAL_BASE;
        const deliveryFiatReward = securedDeliveryFiatReward / securedRewardFactor;

        const securedDeliveryFiatProfit = securedDeliveryFiatReward - deliveryFiatCost;
        const securedDeliveryRelativeProfit = securedDeliveryFiatProfit / deliveryFiatCost;

        const relayDelivery = (
            securedDeliveryFiatProfit > this.evaluationConfig.minDeliveryReward ||
            securedDeliveryRelativeProfit > this.evaluationConfig.relativeMinDeliveryReward
        );

        this.logger.info(
            {
                messageIdentifier: bounty.messageIdentifier,
                maxGasDelivery: bounty.maxGasDelivery,
                maxGasAck: bounty.maxGasAck,
                gasEstimate: gasEstimate.toString(),
                observedGasEstimate: observedGasEstimate.toString(),
                additionalFeeEstimation: additionalFeeEstimate.toString(),
                destinationGasPrice: destinationGasPrice.toString(),
                sourceGasPrice: sourceGasPrice.toString(),
                deliveryCost: deliveryCost.toString(),
                deliveryReward: deliveryReward.toString(),
                maxAckLoss: maxAckLoss.toString(),
                deliveryFiatCost: deliveryFiatCost.toString(),
                deliveryFiatReward: deliveryFiatReward.toString(),
                securedDeliveryFiatReward: securedDeliveryFiatReward.toString(),
                profitabilityFactor: this.evaluationConfig.profitabilityFactor,
                securedDeliveryFiatProfit: securedDeliveryFiatProfit,
                securedDeliveryRelativeProfit: securedDeliveryRelativeProfit,
                minDeliveryReward: this.evaluationConfig.minDeliveryReward,
                relativeMinDeliveryReward: this.evaluationConfig.relativeMinDeliveryReward,
                relayDelivery,
            },
            `Bounty evaluation (source to destination).`,
        );

        return relayDelivery;
    }

    private async evaluateAckSubmission(
        gasEstimateComponents: GasEstimateComponents,
        value: bigint,
        bounty: Bounty,
        incentivesPayload?: BytesLike,
    ): Promise<boolean> {

        const {
            gasEstimate,
            observedGasEstimate,
            additionalFeeEstimate
        } = gasEstimateComponents;

        const sourceGasPrice = await this.getGasPrice(this.chainId);

        const ackCost = this.calcGasCost(           // ! In source chain gas value
            gasEstimate,
            sourceGasPrice,
            additionalFeeEstimate + value
        );

        const ackReward = this.calcGasReward(       // ! In source chain gas value
            observedGasEstimate,
            this.evaluationConfig.unrewardedAckGas,
            BigInt(bounty.maxGasAck),
            bounty.priceOfAckGas
        );

        const adjustedAckReward = ackReward * DECIMAL_BASE_BIG_INT
            / this.profitabilityFactorBigInt;

        const ackProfit = adjustedAckReward - ackCost;      // ! In source chain gas value
        const ackFiatProfit = await this.getGasCostFiatPrice(ackProfit, this.chainId);
        const ackRelativeProfit = Number(ackProfit) / Number(ackCost);

        let deliveryReward = 0n;
        const deliveryCost = bounty.deliveryGasCost ?? 0n;  // This is only present if *this* relayer submitted the message delivery.
        if (deliveryCost != 0n) {

            // Recalculate the delivery reward using the latest pricing info
            const usedGasDelivery = incentivesPayload
                ? await this.getGasUsedForDelivery(incentivesPayload) ?? 0n
                : 0n;   // 'gasUsed' should not be 'undefined', but if it is, continue as if it was 0

            deliveryReward = this.calcGasReward(    // ! In source chain gas value
                usedGasDelivery,
                0n,     // No 'unrewarded' gas, as 'usedGasDelivery' is the exact value that is used to compute the reward.
                BigInt(bounty.maxGasDelivery),
                bounty.priceOfDeliveryGas
            );
        }

        // If the delivery was submitted by *this* relayer, always submit the ack *unless*
        // the net result of doing so is worse than not getting paid for the message
        // delivery.
        const relayAckForDeliveryBounty = deliveryCost != 0n && (ackProfit + deliveryReward > 0n);

        const relayAck = (
            relayAckForDeliveryBounty ||
            ackFiatProfit > this.evaluationConfig.minAckReward ||
            ackRelativeProfit > this.evaluationConfig.relativeMinAckReward
        );

        this.logger.info(
            {
                messageIdentifier: bounty.messageIdentifier,
                maxGasDelivery: bounty.maxGasDelivery,
                maxGasAck: bounty.maxGasAck,
                gasEstimate: gasEstimate.toString(),
                observedGasEstimate: observedGasEstimate.toString(),
                additionalFeeEstimation: additionalFeeEstimate.toString(),
                sourceGasPrice: sourceGasPrice.toString(),
                ackCost: ackCost.toString(),
                ackReward: ackReward.toString(),
                profitabilityFactor: this.evaluationConfig.profitabilityFactor,
                ackFiatProfit: ackFiatProfit.toString(),
                ackRelativeProfit: ackRelativeProfit,
                minAckReward: this.evaluationConfig.minAckReward,
                relativeMinAckReward: this.evaluationConfig.relativeMinAckReward,
                deliveryCost: deliveryCost.toString(),
                deliveryReward: deliveryReward.toString(),
                relayAckForDeliveryBounty,
                relayAck,
            },
            `Bounty evaluation (destination to source).`,
        );

        return relayAck;
    }

    private calcGasCost(
        gas: bigint,
        gasPrice: bigint,
        additionalFee?: bigint,
    ): bigint {
        return gas * gasPrice + (additionalFee ?? 0n);
    }

    private calcGasReward(
        gas: bigint,
        unrewardedGas: bigint,
        bountyMaxGas: bigint,
        bountyPriceOfGas: bigint,
    ): bigint {

        // Subtract the 'unrewardable' gas amount estimate from the gas usage estimation.
        const rewardableGasEstimation = gas > unrewardedGas
            ? gas - unrewardedGas
            : 0n;

        const rewardEstimate = bountyPriceOfGas * (
            rewardableGasEstimation > bountyMaxGas
                ? bountyMaxGas
                : rewardableGasEstimation
        );

        return rewardEstimate;
    }

    private calcMaxGasLoss(
        gasPrice: bigint,
        unrewardedGas: bigint,
        verificationGas: bigint,
        bountyMaxGas: bigint,
        bountyPriceOfGas: bigint,
    ): bigint {

        // The gas used for the 'ack' submission is composed of 3 amounts:
        //   - Logic overhead: is never computed for the reward.
        //   - Verification logic: is only computed for the reward if the source application's
        //     'ack' handler does not use all of the 'ack' gas allowance ('bountyMaxGas').
        //   - Source application's 'ack' handler: it is always computed for the reward (up to a
        //     maximum of 'bountyMaxGas').

        // Evaluate the minimum expected profit from the 'ack' delivery. There are 2 possible
        // scenarios:
        //   - No gas is used by the source application's 'ack' handler.
        //   - The maximum allowed amount of gas is used by the source application's 'ack' handler.

        // NOTE: strictly speaking, 'verificationGas' should be upperbounded by 'bountyMaxGas' on
        // the following line. However, this is not necessary, as in such a case
        // 'maximumGasUsageProfit' will always return a smaller profit than 'minimumGasUsageProfit'.
        const minimumGasUsageReward = verificationGas * bountyPriceOfGas;
        const minimumGasUsageCost = (unrewardedGas + verificationGas) * gasPrice;
        const minimumGasUsageProfit = minimumGasUsageReward - minimumGasUsageCost;

        const maximumGasUsageReward = bountyMaxGas * bountyPriceOfGas;
        const maximumGasUsageCost = (unrewardedGas + verificationGas + bountyMaxGas) * gasPrice;
        const maximumGasUsageProfit = maximumGasUsageReward - maximumGasUsageCost;

        const worstCaseProfit =  minimumGasUsageProfit < maximumGasUsageProfit
            ? minimumGasUsageProfit
            : maximumGasUsageProfit;

        // Only return the 'worstCaseProfit' if it's negative.
        return worstCaseProfit < 0n
            ? worstCaseProfit
            : 0n;
    }

    private async getGasPrice(chainId: string): Promise<bigint> {
        const feeData = await this.wallet.getFeeData(chainId);
        // If gas fee data is missing or incomplete, default the gas price to an extremely high
        // value.
        // ! Use 'gasPrice' over 'maxFeePerGas', as 'maxFeePerGas' defines the highest gas fee
        // ! allowed, which does not necessarilly represent the real gas fee at which the
        // ! transactions are going through.
        const gasPrice = feeData?.gasPrice
            ?? feeData?.maxFeePerGas
            ?? MaxUint256;

        return gasPrice;
    }

    private async getGasCostFiatPrice(amount: bigint, chainId: string): Promise<number> {
        //TODO add timeout?
        const price = await this.pricing.getPrice(chainId, amount);
        if (price == null) {
            throw new Error('Unable to fetch price.');
        }
        return price;
    }

    private async getGasUsedForDelivery(message: BytesLike): Promise<bigint | null> {
        try {
            const payload = ParsePayload(message.toString());

            if (payload == undefined) {
                return null;
            }

            if (payload.context != MessageContext.CTX_DESTINATION_TO_SOURCE) {
                this.logger.warn(
                    { payload },
                    `Unable to extract the 'gasUsed' for delivery. Payload is not a 'destination-to-source' message.`,
                );
                return null;
            }

            return payload.gasSpent;
        }
        catch (error) {
            this.logger.warn(
                { message },
                `Failed to parse generalised incentives payload for 'gasSpent' (on delivery).`
            );
        }

        return null;
    }
}
