import pino from "pino";
import { parentPort, workerData, MessagePort, MessageChannel } from "worker_threads";
import { EvaluateAckResponseMessage, EvaluateDeliveryResponseMessage, EvaluatorGetPortMessage, EvaluatorGetPortResponse, EvaluatorMessage, EvaluatorMessageType, EvaluatorPortData, EvaluatorWorkerData } from "./evaluator.types";
import { Store } from "src/store/store.lib";
import { GasEstimateComponents } from "src/resolvers/resolver";
import { BytesLike, MaxUint256 } from "ethers6";
import { WalletInterface } from "src/wallet/wallet.interface";
import { PricingInterface } from "src/pricing/pricing.interface";
import { MessageContext, ParsePayload } from "src/payload/decode.payload";
import { tryErrorToString } from "src/common/utils";


const DECIMAL_BASE = 10_000;
const DECIMAL_BASE_BIG_INT = BigInt(DECIMAL_BASE);

class EvaluatorWorker {
    private readonly config: EvaluatorWorkerData;

    private readonly logger: pino.Logger;

    private readonly store: Store;

    private readonly pricing: PricingInterface;
    private readonly wallet: WalletInterface;

    private portsCount = 0;
    private readonly ports: Record<number, MessagePort> = {};

    constructor() {
        this.config = workerData as EvaluatorWorkerData;

        this.store = new Store();

        this.pricing = new PricingInterface(this.config.pricingPort);
        this.wallet = new WalletInterface(this.config.walletPort);

        this.logger = this.initializeLogger();

        this.initializePorts();
    }



    // Initialization helpers
    // ********************************************************************************************

    private initializeLogger(): pino.Logger {
        return pino(this.config.loggerOptions).child({
            worker: 'evaluator'
        });
    }

    private initializePorts(): void {
        parentPort!.on('message', (message: EvaluatorGetPortMessage) => {
            const port = this.registerNewPort();
            const response: EvaluatorGetPortResponse = {
                messageId: message.messageId,
                port
            };
            parentPort!.postMessage(response, [port]);
        });
    }

    private registerNewPort(): MessagePort {

        const portId = this.portsCount++;

        const { port1, port2 } = new MessageChannel();

        port1.on('message', (message: EvaluatorPortData) => {
            void this.processRequest(message)
                .then((response) => port1.postMessage(response));
        })

        this.ports[portId] = port1;

        return port2;
    }

    private async processRequest(data: EvaluatorPortData): Promise<EvaluatorPortData> {
        const messageType = data.message.type;
        let returnData: EvaluatorMessage | null = null;
        try {
            switch (messageType) {
                case EvaluatorMessageType.EvaluateDelivery:
                    returnData = await this.evaluateDelivery(
                        data.message.chainId,
                        data.message.messageIdentifier,
                        data.message.gasEstimateComponents,
                        data.message.value,
                    );
                    break;
                case EvaluatorMessageType.EvaluateAck:
                    returnData = await this.evaluateAck(
                        data.message.chainId,
                        data.message.messageIdentifier,
                        data.message.gasEstimateComponents,
                        data.message.value,
                    );
                    break;
                default:
                    this.logger.error(
                        {
                            messageType,
                            request: data
                        },
                        `Unable to handle evaluator request: unknown message type`
                    );
            }

        }
        catch (error) {
            this.logger.error(
                {
                    messageType,
                    request: data,
                    error: tryErrorToString(error),
                },
                `Error on evaluator request processing.`
            );
        }

        return {
            messageId: data.messageId,
            message: returnData ?? { type: EvaluatorMessageType.EmptyResponse },
        }
    }

    
    private async evaluateDelivery(
        chainId: string,
        messageIdentifier: string,
        gasEstimateComponents: GasEstimateComponents,
        value: bigint
    ): Promise<EvaluateDeliveryResponseMessage> {

        const response: EvaluateDeliveryResponseMessage = {
            type: EvaluatorMessageType.EvaluateDeliveryResponse,
            chainId,
            messageIdentifier,
            evaluation: null,
        };

        const evaluationConfig = this.config.evaluationConfigs[chainId];
        if (evaluationConfig == null) {
            this.logger.info(
                {
                    chainId,
                    messageIdentifier,
                },
                `Unable to perform delivery evaluation: no evaluation config found for the 'chainId' provided.`
            );
            // Send a 'null' evaluation response
            return response;
        }

        const relayState = await this.store.getRelayState(messageIdentifier);
        // TODO ideally the check `relayState.toChainId != chainId` would be performed at this point 
        // for extra precaution, but with the current implementation the `toChainId` field is not
        // available until the message is delivered.
        if (relayState?.bountyPlacedEvent == null) {
            this.logger.info(
                {
                    chainId,
                    messageIdentifier,
                },
                `Unable to perform delivery evaluation: no BountyPlaced information found for the 'messageIdentifier' provided.`
            );
            // Send a 'null' evaluation response
            return response;
        }

        const {
            gasEstimate,
            observedGasEstimate,
            additionalFeeEstimate
        } = gasEstimateComponents;
        
        const destinationGasPrice = await this.getGasPrice(chainId);
        const sourceGasPrice = await this.getGasPrice(relayState.bountyPlacedEvent.fromChainId);

        const bountyPlacedEvent = relayState?.bountyPlacedEvent;
        const priceOfDeliveryGas = relayState.bountyIncreasedEvent?.newDeliveryGasPrice
            ?? bountyPlacedEvent.priceOfDeliveryGas;
        const priceOfAckGas = relayState.bountyIncreasedEvent?.newAckGasPrice
            ?? bountyPlacedEvent.priceOfAckGas;

        const deliveryCost = this.calcGasCost(              // ! In destination chain gas value
            gasEstimate,
            destinationGasPrice,
            additionalFeeEstimate + value
        );

        const deliveryReward = this.calcGasReward(          // ! In source chain gas value
            observedGasEstimate,
            evaluationConfig.unrewardedDeliveryGas,
            bountyPlacedEvent.maxGasDelivery,
            priceOfDeliveryGas
        );

        const maxAckLoss = this.calcMaxGasLoss(             // ! In source chain gas value
            sourceGasPrice,
            evaluationConfig.unrewardedAckGas,
            evaluationConfig.verificationAckGas,
            bountyPlacedEvent.maxGasAck,
            priceOfAckGas,
        );


        // Compute the cost and reward of the message delivery in Fiat and evaluate the message
        // delivery profit.
        const deliveryFiatCost = await this.getGasCostFiatPrice(
            deliveryCost,
            chainId
        );

        const adjustedDeliveryReward = evaluationConfig.profitabilityFactor == 0
            ? MaxUint256
            : deliveryReward * DECIMAL_BASE_BIG_INT
                / BigInt(evaluationConfig.profitabilityFactor * DECIMAL_BASE);

        const securedDeliveryReward = adjustedDeliveryReward + maxAckLoss;

        const securedDeliveryFiatReward = await this.getGasCostFiatPrice(
            securedDeliveryReward,
            bountyPlacedEvent.fromChainId
        );

        // Compute the 'deliveryFiatReward' for logging purposes (i.e. without the 'maxAckLoss' factor)
        // If `adjustedDeliveryReward` is 0, then `maxAckLoss` is the sole contributor to
        // `securedDeliveryFiatReward`, and thus `deliveryFiatReward` is 0.
        const securedRewardFactor = adjustedDeliveryReward == 0n
            ? Infinity
            : Number(
                ((adjustedDeliveryReward + maxAckLoss) * DECIMAL_BASE_BIG_INT) / (adjustedDeliveryReward)
            ) / DECIMAL_BASE;
        const deliveryFiatReward = securedDeliveryFiatReward / securedRewardFactor;

        const securedDeliveryFiatProfit = securedDeliveryFiatReward - deliveryFiatCost;
        const securedDeliveryRelativeProfit = securedDeliveryFiatProfit / deliveryFiatCost;

        const relayDelivery = (
            securedDeliveryFiatProfit > evaluationConfig.minDeliveryReward ||
            securedDeliveryRelativeProfit > evaluationConfig.relativeMinDeliveryReward
        );

        response.evaluation = {
            maxGasDelivery: bountyPlacedEvent.maxGasDelivery,
            maxGasAck: bountyPlacedEvent.maxGasAck,
            gasEstimate,
            observedGasEstimate,
            additionalFeeEstimate,
            value,
            destinationGasPrice,
            sourceGasPrice,
            deliveryCost,
            deliveryReward,
            maxAckLoss,
            deliveryFiatCost,
            deliveryFiatReward,
            securedDeliveryFiatReward,
            profitabilityFactor: evaluationConfig.profitabilityFactor,
            securedDeliveryFiatProfit,
            securedDeliveryRelativeProfit,
            minDeliveryReward: evaluationConfig.minDeliveryReward,
            relativeMinDeliveryReward: evaluationConfig.relativeMinDeliveryReward,
            relayDelivery,
        };
        
        return response;
    }

    private async evaluateAck(
        chainId: string,
        messageIdentifier: string,
        gasEstimateComponents: GasEstimateComponents,
        value: bigint,
    ): Promise<EvaluateAckResponseMessage> {

        const response: EvaluateAckResponseMessage = {
            type: EvaluatorMessageType.EvaluateAckResponse,
            chainId,
            messageIdentifier,
            evaluation: null,
        };

        const evaluationConfig = this.config.evaluationConfigs[chainId];
        if (evaluationConfig == null) {
            this.logger.info(
                {
                    chainId,
                    messageIdentifier,
                },
                `Unable to perform ack evaluation: no evaluation config found for the 'chainId' provided.`
            );
            // Send a 'null' evaluation response
            return response
        }

        const relayState = await this.store.getRelayState(messageIdentifier);
        if (relayState?.bountyPlacedEvent == null) {
            this.logger.info(
                {
                    chainId,
                    messageIdentifier,
                },
                `Unable to perform ack evaluation: no BountyPlaced information found for the 'messageIdentifier' provided.`
            );
            // Send a 'null' evaluation response
            return response
        }

        const bountyPlacedEvent = relayState.bountyPlacedEvent;
        if (bountyPlacedEvent.fromChainId != chainId) {
            this.logger.info(
                {
                    chainId,
                    messageIdentifier,
                },
                `Unable to perform ack evaluation: the specified 'chainId' does not match the 'fromChainId' stored on the bounty registry.`
            );
            // Send a 'null' evaluation response
            return response
        }

        const toChainId = relayState.messageDeliveredEvent?.toChainId;
        const ackAMBMessage = toChainId != undefined
            ? await this.store.getAMBMessage(toChainId, messageIdentifier)
            : undefined;
        if (!ackAMBMessage) {
            this.logger.info(
                {
                    chainId,
                    messageIdentifier,
                },
                `Message delivery data not found, ack evaluation will be less accurate.`
            );
        }
        const ackIncentivesPayload = ackAMBMessage?.incentivesPayload;

        const {
            gasEstimate,
            observedGasEstimate,
            additionalFeeEstimate
        } = gasEstimateComponents;

        const sourceGasPrice = await this.getGasPrice(chainId);

        const priceOfDeliveryGas = relayState.bountyIncreasedEvent?.newDeliveryGasPrice
            ?? bountyPlacedEvent.priceOfDeliveryGas;
        const priceOfAckGas = relayState.bountyIncreasedEvent?.newAckGasPrice
            ?? bountyPlacedEvent.priceOfAckGas;

        const ackCost = this.calcGasCost(           // ! In source chain gas value
            gasEstimate,
            sourceGasPrice,
            additionalFeeEstimate + value
        );

        const ackReward = this.calcGasReward(       // ! In source chain gas value
            observedGasEstimate,
            evaluationConfig.unrewardedAckGas,
            bountyPlacedEvent.maxGasAck,
            priceOfAckGas
        );

        const adjustedAckReward = evaluationConfig.profitabilityFactor == 0
            ? MaxUint256
            : ackReward * DECIMAL_BASE_BIG_INT
                / BigInt(evaluationConfig.profitabilityFactor * DECIMAL_BASE);

        const ackProfit = adjustedAckReward - ackCost;      // ! In source chain gas value
        const ackFiatProfit = await this.getGasCostFiatPrice(ackProfit, chainId);
        const ackRelativeProfit = Number(ackProfit) / Number(ackCost);

        let deliveryReward = 0n;
        const deliveryCost = relayState.deliveryGasCost ?? 0n;  // This is only present if *this* relayer submitted the message delivery.
        if (deliveryCost != 0n) {

            // Recalculate the delivery reward using the latest pricing info
            const usedGasDelivery = ackIncentivesPayload
                ? await this.getGasUsedForDelivery(ackIncentivesPayload) ?? 0n
                : 0n;   // 'gasUsed' should not be 'undefined', but if it is, continue as if it was 0

            deliveryReward = this.calcGasReward(    // ! In source chain gas value
                usedGasDelivery,
                0n,     // No 'unrewarded' gas, as 'usedGasDelivery' is the exact value that is used to compute the reward.
                bountyPlacedEvent.maxGasDelivery,
                priceOfDeliveryGas
            );
        }

        // If the delivery was submitted by *this* relayer, always submit the ack *unless*
        // the net result of doing so is worse than not getting paid for the message
        // delivery.
        const relayAckForDeliveryBounty = deliveryCost != 0n && (ackProfit + deliveryReward > 0n);

        const relayAck = (
            relayAckForDeliveryBounty ||
            ackFiatProfit > evaluationConfig.minAckReward ||
            ackRelativeProfit > evaluationConfig.relativeMinAckReward
        );

        response.evaluation = {
            maxGasDelivery: bountyPlacedEvent.maxGasDelivery,
            maxGasAck: bountyPlacedEvent.maxGasAck,
            gasEstimate,
            observedGasEstimate,
            additionalFeeEstimate,
            sourceGasPrice,
            ackCost,
            ackReward,
            profitabilityFactor: evaluationConfig.profitabilityFactor,
            ackFiatProfit,
            ackRelativeProfit,
            minAckReward: evaluationConfig.minAckReward,
            relativeMinAckReward: evaluationConfig.relativeMinAckReward,
            deliveryCost,
            deliveryReward,
            relayAckForDeliveryBounty,
            relayAck,
        };
        
        return response;
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

new EvaluatorWorker();
