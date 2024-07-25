import { Global, Injectable, OnModuleInit } from "@nestjs/common";
import { join } from "path";
import { Worker, MessagePort } from 'worker_threads';
import { tryErrorToString } from "src/common/utils";
import { ConfigService } from "src/config/config.service";
import { LoggerService, STATUS_LOG_INTERVAL } from "src/logger/logger.service";
import { EvaluatorGetPortResponse, EvaluatorGetPortMessage, EvaluationConfig, EvaluatorWorkerData, EVALUATOR_DEFAULT_MIN_ACK_REWARD, EVALUATOR_DEFAULT_MIN_DELIVERY_REWARD, EVALUATOR_DEFAULT_PROFITABILITY_FACTOR, EVALUATOR_DEFAULT_RELATIVE_MIN_ACK_REWARD, EVALUATOR_DEFAULT_RELATIVE_MIN_DELIVERY_REWARD, EVALUATOR_DEFAULT_UNREWARDED_ACK_GAS, EVALUATOR_DEFAULT_UNREWARDED_DELIVERY_GAS, EVALUATOR_DEFAULT_VERIFICATION_ACK_GAS, EVALUATOR_DEFAULT_VERIFICATION_DELIVERY_GAS } from "./evaluator.types";
import { PricingService } from "src/pricing/pricing.service";
import { WalletService } from "src/wallet/wallet.service";


@Global()
@Injectable()
export class EvaluatorService implements OnModuleInit {
    private worker: Worker | null = null;
    private requestPortMessageId = 0;

    private setReady!: () => void;
    readonly isReady: Promise<void>;

    constructor(
        private readonly configService: ConfigService,
        private readonly pricingService: PricingService,
        private readonly walletService: WalletService,
        private readonly loggerService: LoggerService,
    ) {
        this.isReady = this.initializeIsReady();
    }

    async onModuleInit() {
        this.loggerService.info(`Starting Evaluator worker...`);

        await this.initializeWorker();

        this.initiateIntervalStatusLog();

        this.setReady();
    }

    private initializeIsReady(): Promise<void> {
        return new Promise<void>((resolve) => {
            this.setReady = resolve;
        });
    }

    private async initializeWorker(): Promise<void> {
        const workerData = await this.loadWorkerConfig();
        
        this.worker = new Worker(join(__dirname, 'evaluator.worker.js'), {
            workerData,
            transferList: [
                workerData.pricingPort,
                workerData.walletPort
            ]
        });

        this.worker.on('error', (error) => {
            this.loggerService.fatal(
                { error: tryErrorToString(error) },
                `Error on evaluator worker.`,
            );
        });

        this.worker.on('exit', (exitCode) => {
            this.worker = null;
            this.loggerService.fatal(
                { exitCode },
                `Evaluator worker exited.`,
            );
        });
    }

    private async loadWorkerConfig(): Promise<EvaluatorWorkerData> {
        const globalEvaluatorConfig = this.configService.globalConfig.evaluator;

        const evaluationConfigs: Record<string, EvaluationConfig> = {};

        for (const [chainId, chainConfig] of this.configService.chainsConfig) {
            const chainEvaluatorConfig = chainConfig.evaluator;

            const chainEvaluationConfig: EvaluationConfig = {

                unrewardedDeliveryGas: chainEvaluatorConfig.unrewardedDeliveryGas
                    ?? globalEvaluatorConfig.unrewardedDeliveryGas
                    ?? EVALUATOR_DEFAULT_UNREWARDED_DELIVERY_GAS,

                verificationDeliveryGas: chainEvaluatorConfig.verificationDeliveryGas
                    ?? globalEvaluatorConfig.verificationDeliveryGas
                    ?? EVALUATOR_DEFAULT_VERIFICATION_DELIVERY_GAS,

                minDeliveryReward: chainEvaluatorConfig.minDeliveryReward
                    ?? globalEvaluatorConfig.minDeliveryReward
                    ?? EVALUATOR_DEFAULT_MIN_DELIVERY_REWARD,

                relativeMinDeliveryReward: chainEvaluatorConfig.relativeMinDeliveryReward
                    ?? globalEvaluatorConfig.relativeMinDeliveryReward
                    ?? EVALUATOR_DEFAULT_RELATIVE_MIN_DELIVERY_REWARD,

                unrewardedAckGas: chainEvaluatorConfig.unrewardedAckGas
                    ?? globalEvaluatorConfig.unrewardedAckGas
                    ?? EVALUATOR_DEFAULT_UNREWARDED_ACK_GAS,

                verificationAckGas: chainEvaluatorConfig.verificationAckGas
                    ?? globalEvaluatorConfig.verificationAckGas
                    ?? EVALUATOR_DEFAULT_VERIFICATION_ACK_GAS,

                minAckReward: chainEvaluatorConfig.minAckReward
                    ?? globalEvaluatorConfig.minAckReward
                    ?? EVALUATOR_DEFAULT_MIN_ACK_REWARD,

                relativeMinAckReward: chainEvaluatorConfig.relativeMinAckReward
                    ?? globalEvaluatorConfig.relativeMinAckReward
                    ?? EVALUATOR_DEFAULT_RELATIVE_MIN_ACK_REWARD,

                profitabilityFactor: chainEvaluatorConfig.profitabilityFactor
                    ?? globalEvaluatorConfig.profitabilityFactor
                    ?? EVALUATOR_DEFAULT_PROFITABILITY_FACTOR,

            }

            evaluationConfigs[chainId] = chainEvaluationConfig;
        }

        return {
            evaluationConfigs,
            pricingPort: await this.pricingService.attachToPricing(),
            walletPort: await this.walletService.attachToWallet(),
            loggerOptions: this.loggerService.loggerOptions
        }
    }

    private initiateIntervalStatusLog(): void {
        const logStatus = () => {
            const isActive = this.worker != null;
            this.loggerService.info(
                { isActive },
                'Evaluator worker status.'
            );
        };
        setInterval(logStatus, STATUS_LOG_INTERVAL);
    }


    private getNextRequestPortMessageId(): number {
        return this.requestPortMessageId++;
    }

    async attachToEvaluator(): Promise<MessagePort> {

        await this.isReady;

        const worker = this.worker;
        if (worker == undefined) {
            throw new Error(`Evaluator worker is null.`);
        }

        const messageId = this.getNextRequestPortMessageId();
        const portPromise = new Promise<MessagePort>((resolve) => {
            const listener = (data: EvaluatorGetPortResponse) => {
                if (data.messageId === messageId) {
                    worker.off("message", listener);
                    resolve(data.port);
                }
            };
            worker.on("message", listener);

            const portMessage: EvaluatorGetPortMessage = { messageId };
            worker.postMessage(portMessage);
        });

        return portPromise;
    }

}
