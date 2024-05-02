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
import { tryErrorToString, wait } from 'src/common/utils';
import { BytesLike, FeeData, JsonRpcProvider, MaxUint256, zeroPadValue } from 'ethers6';
import { ParsePayload, MessageContext } from 'src/payload/decode.payload';
import { PricingInterface } from 'src/pricing/pricing.interface';


export class EvalQueue extends ProcessingQueue<EvalOrder, SubmitOrder> {
    readonly relayerAddress: string;

    private feeData: FeeData | undefined;

    constructor(
        retryInterval: number,
        maxTries: number,
        relayerAddress: string,
        private readonly store: Store,
        private readonly incentivesContracts: Map<string, IncentivizedMessageEscrow>,
        private readonly chainId: string,
        private readonly evaluationcConfig: BountyEvaluationConfig,
        private readonly pricing: PricingInterface,
        private readonly provider: JsonRpcProvider,
        private readonly logger: pino.Logger,
    ) {
        super(retryInterval, maxTries);
        this.relayerAddress = zeroPadValue(relayerAddress, 32);
    }

    override async init(): Promise<void> {
        await this.initializeFeeData();
    }

    protected override async onProcessOrders(): Promise<void> {
        await this.updateFeeData();
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
            
            // Evaluate the cost of packet relaying
            //TODO for delivery, the ack reward must be taken into account
            //TODO  - Skip delivery if maxGasAck is too small?
            //TODO  - Take into account the ack gas price somehow?
            const gasCostEstimate = this.getGasCost(gasEstimation); 
            const deliveryFiatCost = await this.getGasCostFiatPrice(gasCostEstimate, this.chainId);

            const maxGasDelivery = BigInt(bounty.maxGasDelivery);
            const gasRewardEstimate = bounty.priceOfDeliveryGas * (
                gasEstimation > maxGasDelivery ? maxGasDelivery : gasEstimation //TODO gasEstimation is too large (it does not take into account that gas used by verification logic is not paid for)
            );
            const deliveryFiatReward = await this.getGasCostFiatPrice(gasRewardEstimate, bounty.fromChainId);

            const deliveryFiatProfit = deliveryFiatReward - deliveryFiatCost;

            const relayDelivery = (
                deliveryFiatProfit > this.evaluationcConfig.minDeliveryReward ||
                deliveryFiatProfit / deliveryFiatCost > this.evaluationcConfig.relativeMinDeliveryReward
            );

            this.logger.debug(
                {
                    messageIdentifier,
                    maxGasDelivery: bounty.maxGasDelivery,
                    gasEstimation: gasEstimation.toString(),
                    deliveryFiatCost,
                    deliveryFiatReward,
                    deliveryFiatProfit,
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

            // Evaluate the cost of packet relaying
            const gasCostEstimate = this.getGasCost(gasEstimation); 
            const ackFiatCost = await this.getGasCostFiatPrice(gasCostEstimate, this.chainId);

            const maxGasAck = BigInt(bounty.maxGasAck);
            const gasRewardEstimate = bounty.priceOfAckGas * (
                gasEstimation > maxGasAck ? maxGasAck : gasEstimation   //TODO gasEstimation is too large
            );
            const ackFiatReward = await this.getGasCostFiatPrice(gasRewardEstimate, this.chainId);

            const ackFiatProfit = ackFiatReward - ackFiatCost;
            const deliveryCost = bounty.deliveryGasCost ?? 0n;  // This is only present if *this* relayer submitted the message delivery.
            
            let relayAck: boolean;
            let deliveryFiatReward = 0;
            if (deliveryCost != 0n) {
                // If the delivery was submitted by *this* relayer, always submit the ack *unless*
                // the net result of doing so is worse than not getting paid for the message
                // delivery.

                // Recalculate the delivery reward using the latest pricing info
                const usedGasDelivery = order.incentivesPayload
                    ? await this.getGasUsedForDelivery(order.incentivesPayload) ?? 0n
                    : 0n;  // 'gasUsed' should not be 'undefined', but if it is, continue as if it was 0
                const maxGasDelivery = BigInt(bounty.maxGasDelivery);
                const deliveryGasReward = bounty.priceOfDeliveryGas * (
                    usedGasDelivery > maxGasDelivery ? maxGasDelivery : usedGasDelivery
                );
                deliveryFiatReward = await this.getGasCostFiatPrice(deliveryGasReward, this.chainId);

                relayAck = (ackFiatProfit + deliveryFiatReward) > 0n;
            }
            else {
                relayAck = (
                    ackFiatProfit > this.evaluationcConfig.minAckReward ||
                    ackFiatProfit / ackFiatCost > this.evaluationcConfig.relativeMinAckReward
                );
            }

            this.logger.debug(
                {
                    messageIdentifier,
                    maxGasAck: bounty.maxGasAck,
                    gasEstimation: gasEstimation.toString(),
                    ackFiatCost,
                    ackFiatReward,
                    ackFiatProfit,
                    deliveryFiatReward,
                    relayAck,
                },
                `Bounty evaluation (destination to source).`,
            );

            return relayAck ? gasEstimation : 0n;
        }

        return 0n; // Do not relay packet
    }


    private async initializeFeeData(): Promise<void> {
        let tryCount = 0;
        while (this.feeData == undefined) {
            try {
                this.feeData = await this.provider.getFeeData();
            } catch {
                this.logger.warn(
                    { try: ++tryCount },
                    'Failed to initialize feeData on submitter eval-queue. Worker locked until successful update.'
                );
                await wait(this.retryInterval);
            }
        }
    }

    private async updateFeeData(): Promise<void> {
        try {
            this.feeData = await this.provider.getFeeData();
        } catch {
            // Continue with stale fee data.
        }
    }

    private getGasCost(gas: bigint): bigint {
        // TODO! this should depend on the wallet's latest gas info AND on the config adjustments!
        // TODO! OR the gas price should be sent to the wallet!
        // If gas fee data is missing or incomplete, default the gas price to an extremely high
        // value.
        const gasPrice = this.feeData?.maxFeePerGas
            ?? this.feeData?.maxFeePerGas
            ?? MaxUint256;

        return gas * gasPrice;
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
