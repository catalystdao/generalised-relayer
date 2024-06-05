import {
    HandleOrderResult,
    ProcessingQueue,
} from '../../processing-queue/processing-queue';
import { BountyEvaluationConfig, EvalOrder, SubmitOrder } from '../submitter.types';
import pino from 'pino';
import { Store } from 'src/store/store.lib';
import { Bounty } from 'src/store/types/store.types';
import { BountyStatus } from 'src/store/types/bounty.enum';
import { IncentivizedMessageEscrow } from 'src/contracts';
import { tryErrorToString } from 'src/common/utils';
import { BytesLike, MaxUint256, zeroPadValue } from 'ethers6';
import { ParsePayload, MessageContext } from 'src/payload/decode.payload';
import { PricingInterface } from 'src/pricing/pricing.interface';
import { WalletInterface } from 'src/wallet/wallet.interface';


export class EvalQueue extends ProcessingQueue<EvalOrder, SubmitOrder> {
    readonly relayerAddress: string;

    constructor(
        retryInterval: number,
        maxTries: number,
        relayerAddress: string,
        private readonly store: Store,
        private readonly incentivesContracts: Map<string, IncentivizedMessageEscrow>,
        private readonly chainId: string,
        private readonly evaluationConfig: BountyEvaluationConfig,
        private readonly pricing: PricingInterface,
        private readonly wallet: WalletInterface,
        private readonly logger: pino.Logger,
    ) {
        super(retryInterval, maxTries);
        this.relayerAddress = zeroPadValue(relayerAddress, 32);
    }

    protected async handleOrder(
        order: EvalOrder,
        _retryCount: number,
    ): Promise<HandleOrderResult<SubmitOrder> | null> {
        const bounty = await this.queryBountyInfo(order.messageIdentifier);
        if (bounty === null || bounty === undefined) {
            throw Error(
                `Bounty of message not found on evaluation (message ${order.messageIdentifier})`,
            );
        }

        const gasLimit = await this.evaluateBounty(order, bounty);
        const isDelivery = bounty.fromChainId != this.chainId;

        if (gasLimit > 0) {
            // Move the order to the submit queue
            return { result: { ...order, gasLimit, isDelivery } };
        } else {
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
            if (result?.gasLimit != null && result.gasLimit > 0) {
                this.logger.debug(
                    orderDescription,
                    `Successful bounty evaluation: submit order.`,
                );
            } else {
                this.logger.debug(
                    orderDescription,
                    `Successful bounty evaluation: drop order.`,
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

    private async evaluateBounty(order: EvalOrder, bounty: Bounty): Promise<bigint> {
        const messageIdentifier = order.messageIdentifier;

        // Check if the bounty has already been submitted/is in process of being submitted
        const isDelivery = bounty.fromChainId != this.chainId;
        if (isDelivery) {
            // Source to Destination
            if (bounty.status >= BountyStatus.MessageDelivered) {
                this.logger.debug(
                    { messageIdentifier },
                    `Bounty evaluation (source to destination). Bounty already delivered.`,
                );
                return 0n; // Do not relay packet
            }
        } else {
            // Destination to Source
            if (bounty.status >= BountyStatus.BountyClaimed) {
                this.logger.debug(
                    { messageIdentifier },
                    `Bounty evaluation (destination to source). Bounty already acked.`,
                );
                return 0n; // Do not relay packet
            }
        }

        const contract = this.incentivesContracts.get(order.amb)!; //TODO handle undefined case
        const gasEstimation = await contract.processPacket.estimateGas(
            order.messageCtx,
            order.message,
            this.relayerAddress,
        );

        if (isDelivery) {
            //TODO is this correct? Is this desired?
            // Source to Destination
            if (order.priority) {
                this.logger.debug(
                    {
                        messageIdentifier,
                        maxGasDelivery: bounty.maxGasDelivery,
                        gasEstimation: gasEstimation.toString(),
                        priority: true,
                    },
                    `Bounty evaluation (source to destination).`,
                );

                return gasEstimation;
            }

            const destinationGasPrice = await this.getGasPrice(this.chainId);
            const sourceGasPrice = await this.getGasPrice(bounty.fromChainId);

            const deliveryCostEstimate = this.calcGasCost(         // ! In destination chain gas value
                gasEstimation,
                destinationGasPrice
            );

            const deliveryRewardEstimate = this.calcGasReward(     // ! In source chain gas value
                gasEstimation,
                this.evaluationConfig.unrewardedDeliveryGas,
                BigInt(bounty.maxGasDelivery),
                bounty.priceOfDeliveryGas
            );

            // Consider the worst 'ack' submission profit, as in that case no will desire to submit
            // the 'ack', and this relayer will have to submit it in order to get the payment
            // for the delivery.
            const maxAckLossEstimate = this.calcMaxGasLoss(             // ! In source chain gas value
                sourceGasPrice,
                this.evaluationConfig.unrewardedAckGas,
                BigInt(bounty.maxGasAck),
                bounty.priceOfAckGas,
            );


            // Compute the cost and reward of the message delivery (in Fiat) and evaluate the message delivery profit
            const deliveryFiatCostEstimate = await this.getGasCostFiatPrice(deliveryCostEstimate, this.chainId);

            const correctedDeliveryRewardEstimate = deliveryRewardEstimate - maxAckLossEstimate;
            const deliveryFiatRewardEstimate = await this.getGasCostFiatPrice(correctedDeliveryRewardEstimate, bounty.fromChainId);

            const deliveryFiatProfit = deliveryFiatRewardEstimate - deliveryFiatCostEstimate;

            const relayDelivery = (
                deliveryFiatProfit > this.evaluationConfig.minDeliveryReward ||
                deliveryFiatProfit / deliveryFiatCostEstimate > this.evaluationConfig.relativeMinDeliveryReward
            );

            this.logger.debug(
                {
                    messageIdentifier,
                    maxGasDelivery: bounty.maxGasDelivery,
                    maxGasAck: bounty.maxGasAck,
                    deliveryGasEstimation: gasEstimation.toString(),
                    destinationGasPrice: destinationGasPrice.toString(),
                    sourceGasPrice: sourceGasPrice.toString(),
                    deliveryCostEstimate: deliveryCostEstimate.toString(),
                    deliveryRewardEstimate: deliveryRewardEstimate.toString(),
                    maxAckLossEstimate: maxAckLossEstimate.toString(),
                    deliveryFiatCostEstimate: deliveryFiatCostEstimate.toString(),
                    deliveryFiatRewardEstimate: deliveryFiatRewardEstimate.toString(),
                    deliveryFiatProfit: deliveryFiatProfit.toString(),
                    minDeliveryReward: this.evaluationConfig.minDeliveryReward,
                    relativeMinDeliveryReward: this.evaluationConfig.relativeMinDeliveryReward,
                    relayDelivery,
                },
                `Bounty evaluation (source to destination).`,
            );

            return relayDelivery ? gasEstimation : 0n;
        } else {
            // Destination to Source
            if (order.priority) {
                this.logger.debug(
                    {
                        messageIdentifier,
                        maxGasAck: bounty.maxGasAck,
                        gasEstimation: gasEstimation.toString(),
                        priority: true,
                    },
                    `Bounty evaluation (destination to source).`,
                );

                return gasEstimation;
            }

            // Evaluate the cost of the 'ack' relaying
            const sourceGasPrice = await this.getGasPrice(bounty.fromChainId);

            const ackCostEstimate = this.calcGasCost(       // ! In source chain gas value
                gasEstimation,
                sourceGasPrice
            );

            const ackRewardEstimate = this.calcGasReward(   // ! In source chain gas value
                gasEstimation,
                this.evaluationConfig.unrewardedAckGas,
                BigInt(bounty.maxGasAck),
                bounty.priceOfAckGas
            );

            const deliveryCost = bounty.deliveryGasCost ?? 0n;  // This is only present if *this* relayer submitted the message delivery.

            let deliveryReward = 0n;
            if (deliveryCost != 0n) {

                // Recalculate the delivery reward using the latest pricing info
                const usedGasDelivery = order.incentivesPayload
                    ? await this.getGasUsedForDelivery(order.incentivesPayload) ?? 0n
                    : 0n;  // 'gasUsed' should not be 'undefined', but if it is, continue as if it was 0

                deliveryReward = this.calcGasReward(        // ! In source chain gas value
                    usedGasDelivery,
                    0n,
                    BigInt(bounty.maxGasDelivery),
                    bounty.priceOfDeliveryGas
                );
            }

            const ackProfit = ackRewardEstimate - ackCostEstimate;
            const ackFiatProfit = await this.getGasCostFiatPrice(ackProfit, this.chainId);
            const relativeProfit = Number(ackProfit) / Number(ackCostEstimate);

            // If the delivery was submitted by *this* relayer, always submit the ack *unless*
            // the net result of doing so is worse than not getting paid for the message
            // delivery.
            const relayAckForDeliveryBounty = deliveryCost != 0n && (ackProfit + deliveryReward > 0n);

            const relayAck = (
                relayAckForDeliveryBounty ||
                ackFiatProfit > this.evaluationConfig.minAckReward ||
                relativeProfit > this.evaluationConfig.relativeMinAckReward
            );

            this.logger.debug(
                {
                    messageIdentifier,
                    maxGasDelivery: bounty.maxGasDelivery,
                    maxGasAck: bounty.maxGasAck,
                    ackGasEstimation: gasEstimation.toString(),
                    sourceGasPrice: sourceGasPrice.toString(),
                    deliveryCost: deliveryCost.toString(),
                    deliveryReward: deliveryReward.toString(),
                    ackCostEstimate: ackCostEstimate.toString(),
                    ackRewardEstimate: ackRewardEstimate.toString(),
                    ackFiatProfit: ackFiatProfit.toString(),
                    minAckReward: this.evaluationConfig.minAckReward,
                    relativeMinAckReward: this.evaluationConfig.relativeMinAckReward,
                    relayAck,
                },
                `Bounty evaluation (destination to source).`,
            );

            return relayAck ? gasEstimation : 0n;
        }

        return 0n; // Do not relay packet
    }

    private calcGasCost(
        gas: bigint,
        gasPrice: bigint,
    ): bigint {
        return gas * gasPrice;
    }

    private calcGasReward(
        gas: bigint,
        unrewardedGas: bigint,
        bountyMaxGas: bigint,
        bountyPriceOfGas: bigint,
    ): bigint {

        // Subtract an estimate of the amount of 'unrewardable' gas from the gas usage estimation.
        const rewardableDeliveryGasEstimation = gas > unrewardedGas
            ? gas - unrewardedGas
            : 0n;

        const deliveryRewardEstimate = bountyPriceOfGas * (
            rewardableDeliveryGasEstimation > bountyMaxGas
                ? bountyMaxGas
                : rewardableDeliveryGasEstimation
        );

        return deliveryRewardEstimate;
    }

    private calcMaxGasLoss(
        gasPrice: bigint,
        unrewardedGas: bigint,
        bountyMaxGas: bigint,
        bountyPriceOfGas: bigint,
    ): bigint {
        // Evaluate the worst possible loss of a submission. There are 2 possible scenarios:
        //   - The provided `bountyPriceOfGas` covers the current gas price: the worst loss
        //     will occur if no gas is used for the submission logic (and hence there is no bounty 
        //     reward).
        //   - The provided `bountyPriceOfGas' does *not* cover the current gas price: the 
        //     worst loss will occur if the maximum allowed amount of gas is used for the 
        //     submission logic.

        const fixedCost = unrewardedGas * gasPrice;

        const worstCaseVariableCost = gasPrice > bountyPriceOfGas
            ? bountyMaxGas * (gasPrice - bountyPriceOfGas)
            : 0n;

        return fixedCost + worstCaseVariableCost;
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
