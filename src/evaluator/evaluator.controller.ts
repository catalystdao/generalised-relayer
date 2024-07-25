import { BadRequestException, Controller, Get, OnModuleInit, Query } from "@nestjs/common";
import { EvaluatorInterface } from "./evaluator.interface";
import { EvaluatorService } from "./evaluator.service";
import { EvaluateAckQuery, EvaluateAckQueryResponse, EvaluateDeliveryQuery, EvaluteDeliveryQueryResponse } from "./evaluator.types";

@Controller()
export class EvaluatorController implements OnModuleInit {
    private evaluator!: EvaluatorInterface;

    constructor(
        private readonly evaluatorService: EvaluatorService,
    ) {}

    async onModuleInit() {
        await this.initializeEvaluatorInterface();    
    }

    private async initializeEvaluatorInterface(): Promise<void> {
        const port = await this.evaluatorService.attachToEvaluator();
        this.evaluator = new EvaluatorInterface(port);
    }

    @Get('evaluateDelivery')
    async evaluateDelivery(@Query() query: EvaluateDeliveryQuery): Promise<any> {

        //TODO validate query format
        const result = await this.evaluator.evaluateDelivery(
            query.chainId,
            query.messageIdentifier,
            {
                gasEstimate: BigInt(query.gasEstimate),
                observedGasEstimate: BigInt(query.observedGasEstimate),
                additionalFeeEstimate: BigInt(query.additionalFeeEstimate),
            },
            BigInt(query.value)
        );

        if (result.evaluation == undefined) {
            throw new BadRequestException('Failed to generate an evaluation output for the given parameters.');
        }

        const response: EvaluteDeliveryQueryResponse = {
            chainId: result.chainId,
            messageIdentifier: result.messageIdentifier,
            maxGasDelivery: result.evaluation.maxGasDelivery.toString(),
            maxGasAck: result.evaluation.maxGasAck.toString(),
            gasEstimate: result.evaluation.gasEstimate.toString(),
            observedGasEstimate: result.evaluation.observedGasEstimate.toString(),
            additionalFeeEstimate: result.evaluation.additionalFeeEstimate.toString(),
            destinationGasPrice: result.evaluation.destinationGasPrice.toString(),
            value: result.evaluation.value.toString(),
            sourceGasPrice: result.evaluation.sourceGasPrice.toString(),
            deliveryCost: result.evaluation.deliveryCost.toString(),
            deliveryReward: result.evaluation.deliveryReward.toString(),
            maxAckLoss: result.evaluation.maxAckLoss.toString(),
            deliveryFiatCost: result.evaluation.deliveryFiatCost,
            deliveryFiatReward: result.evaluation.deliveryFiatReward,
            securedDeliveryFiatReward: result.evaluation.securedDeliveryFiatReward,
            profitabilityFactor: result.evaluation.profitabilityFactor,
            securedDeliveryFiatProfit: result.evaluation.securedDeliveryFiatProfit,
            securedDeliveryRelativeProfit: result.evaluation.securedDeliveryRelativeProfit,
            minDeliveryReward: result.evaluation.minDeliveryReward,
            relativeMinDeliveryReward: result.evaluation.relativeMinDeliveryReward,
            relayDelivery: result.evaluation.relayDelivery,
        }

        return response;
    }

    @Get('evaluateAck')
    async evaluateAck(@Query() query: EvaluateAckQuery): Promise<any> {

        //TODO validate query format
        const result = await this.evaluator.evaluateAck(
            query.chainId,
            query.messageIdentifier,
            {
                gasEstimate: BigInt(query.gasEstimate),
                observedGasEstimate: BigInt(query.observedGasEstimate),
                additionalFeeEstimate: BigInt(query.additionalFeeEstimate),
            },
            BigInt(query.value)
        );

        if (result.evaluation == undefined) {
            throw new BadRequestException('Failed to generate an evaluation output for the given parameters.');
        }

        const response: EvaluateAckQueryResponse = {
            chainId: result.chainId,
            messageIdentifier: result.messageIdentifier,
            maxGasDelivery: result.evaluation.maxGasDelivery.toString(),
            maxGasAck: result.evaluation.maxGasAck.toString(),
            gasEstimate: result.evaluation.gasEstimate.toString(),
            observedGasEstimate: result.evaluation.observedGasEstimate.toString(),
            additionalFeeEstimate: result.evaluation.additionalFeeEstimate.toString(),
            sourceGasPrice: result.evaluation.sourceGasPrice.toString(),
            ackCost: result.evaluation.ackCost.toString(),
            ackReward: result.evaluation.ackReward.toString(),
            profitabilityFactor: result.evaluation.profitabilityFactor,
            ackFiatProfit: result.evaluation.ackFiatProfit,
            ackRelativeProfit: result.evaluation.ackRelativeProfit,
            minAckReward: result.evaluation.minAckReward,
            relativeMinAckReward: result.evaluation.relativeMinAckReward,
            deliveryCost: result.evaluation.deliveryCost.toString(),
            deliveryReward: result.evaluation.deliveryReward.toString(),
            relayAckForDeliveryBounty: result.evaluation.relayAckForDeliveryBounty,
            relayAck: result.evaluation.relayAck,
        }

        return response;
    }
}
