import { LoggerService, STATUS_LOG_INTERVAL } from './../logger/logger.service';
import { ConfigService } from './../config/config.service';
import { Global, Injectable, OnModuleInit } from "@nestjs/common";
import { join } from 'path';
import { Worker, MessagePort } from 'worker_threads';
import { tryErrorToString } from 'src/common/utils';
import { PricingProviderConfig } from './pricing.provider';
import { LoggerOptions } from 'pino';
import { PricingGetPortMessage, PricingGetPortResponse } from './pricing.types';

export const PRICING_DEFAULT_COIN_DECIMALS = 18;
export const PRICING_DEFAULT_CACHE_DURATION = 5 * 60 * 1000;
export const PRICING_DEFAULT_PRICING_DENOMINATION = 'usd';
export const PRICING_DEFAULT_RETRY_INTERVAL = 2000;
export const PRICING_DEFAULT_MAX_TRIES = 3;

export interface PricingWorkerData {
    chainPricingProvidersConfig: Record<string, PricingProviderConfig>;
    loggerOptions: LoggerOptions;
}

@Global()
@Injectable()
export class PricingService implements OnModuleInit {
    private worker: Worker | null = null;
    private requestPortMessageId = 0;

    constructor(
        private readonly configService: ConfigService,
        private readonly loggerService: LoggerService,
    ) {}

    onModuleInit() {
        this.loggerService.info(`Starting Pricing worker...`);

        this.initializeWorker();

        this.initiateIntervalStatusLog();
    }

    private initializeWorker(): void {
        const workerData = this.loadWorkerConfig();
        
        this.worker = new Worker(join(__dirname, 'pricing.worker.js'), {
            workerData
        });

        this.worker.on('error', (error) => {
            this.loggerService.fatal(
                { error: tryErrorToString(error) },
                `Error on pricing worker.`,
            );
        });

        this.worker.on('exit', (exitCode) => {
            this.worker = null;
            this.loggerService.fatal(
                { exitCode },
                `Pricing worker exited.`,
            );
        });
    }

    private loadWorkerConfig(): PricingWorkerData {
        const globalPricingConfig = this.configService.globalConfig.pricing;
        
        const chainPricingProvidersConfig: Record<string, PricingProviderConfig> = {};

        for (const [chainId, chainConfig] of this.configService.chainsConfig) {
            const chainPricingConfig = chainConfig.pricing;

            const provider = chainPricingConfig.provider ?? globalPricingConfig.provider;
            if (provider == undefined) {
                this.loggerService.warn(
                    { chainId },
                    `No pricing provider specified. Skipping chain. (CHAIN WILL NOT BE ABLE TO RELAY PACKETS)`
                );
                continue;
            }

            // Set the 'common' pricing configuration
            const pricingProviderConfig: PricingProviderConfig = {
                provider,
                coinDecimals: chainPricingConfig.coinDecimals
                    ?? globalPricingConfig.coinDecimals
                    ?? PRICING_DEFAULT_COIN_DECIMALS,
                pricingDenomination: chainPricingConfig.pricingDenomination
                    ?? globalPricingConfig.pricingDenomination
                    ?? PRICING_DEFAULT_PRICING_DENOMINATION,
                cacheDuration: chainPricingConfig.cacheDuration
                    ?? globalPricingConfig.cacheDuration
                    ?? PRICING_DEFAULT_CACHE_DURATION,
                retryInterval: chainPricingConfig.retryInterval
                    ?? globalPricingConfig.retryInterval
                    ?? PRICING_DEFAULT_RETRY_INTERVAL,
                maxTries: chainPricingConfig.maxTries
                    ?? globalPricingConfig.maxTries
                    ?? PRICING_DEFAULT_MAX_TRIES,
            }

            // Set the 'default' provider-specific options (if the chain provider matches the
            // default one)
            if (provider === globalPricingConfig.provider) {
                for (const [key, value] of Object.entries(globalPricingConfig.providerSpecificConfig)) {
                    pricingProviderConfig[key] = value;
                }
            }

            // Set the chain provider-specific options (will override any 'default' options set
            // that have matching keys)
            for (const [key, value] of Object.entries(chainPricingConfig.providerSpecificConfig)) {
                pricingProviderConfig[key] = value;
            }
        }

        return {
            chainPricingProvidersConfig: chainPricingProvidersConfig,
            loggerOptions: this.loggerService.loggerOptions
        }
    }

    private initiateIntervalStatusLog(): void {
        const logStatus = () => {
            const isActive = this.worker != null;
            this.loggerService.info(
                { isActive },
                'Pricing worker status.'
            );
        };
        setInterval(logStatus, STATUS_LOG_INTERVAL);
    }


    private getNextRequestPortMessageId(): number {
        return this.requestPortMessageId++;
    }

    async attachToPricing(): Promise<MessagePort> {

        const worker = this.worker;
        if (worker == undefined) {
            throw new Error(`Pricing worker is null.`);
        }

        const messageId = this.getNextRequestPortMessageId();
        const portPromise = new Promise<MessagePort>((resolve) => {
            const listener = (data: PricingGetPortResponse) => {
                if (data.messageId === messageId) {
                    worker.off("message", listener);
                    resolve(data.port);
                }
            };
            worker.on("message", listener);

            const portMessage: PricingGetPortMessage = { messageId };
            worker.postMessage(portMessage);
        });

        return portPromise;
    }
}