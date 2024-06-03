import { Injectable } from '@nestjs/common';
import { join } from 'path';
import { Worker, MessagePort } from 'worker_threads';
import { ConfigService } from 'src/config/config.service';
import { ChainConfig } from 'src/config/config.types';
import { LoggerService } from 'src/logger/logger.service';
import { LoggerOptions } from 'pino';
import { WalletService } from 'src/wallet/wallet.service';
import { Wallet } from 'ethers6';
import { tryErrorToString } from 'src/common/utils';
import { PricingService } from 'src/pricing/pricing.service';

const RETRY_INTERVAL_DEFAULT = 30000;
const PROCESSING_INTERVAL_DEFAULT = 100;
const MAX_TRIES_DEFAULT = 3;
const MAX_PENDING_TRANSACTIONS = 50;
const NEW_ORDERS_DELAY_DEFAULT = 0;
const UNREWARDED_DELIVERY_GAS_DEFAULT = 0n;
const MIN_DELIVERY_REWARD_DEFAULT = 0;
const RELATIVE_MIN_DELIVERY_REWARD_DEFAULT = 0;
const UNREWARDED_ACK_GAS_DEFAULT = 0n;
const MIN_ACK_REWARD_DEFAULT = 0;
const RELATIVE_MIN_ACK_REWARD_DEFAULT = 0;

interface GlobalSubmitterConfig {
    enabled: boolean;
    newOrdersDelay: number;
    retryInterval: number;
    processingInterval: number;
    maxTries: number;
    maxPendingTransactions: number;
    unrewardedDeliveryGas: bigint;
    minDeliveryReward: number;
    relativeMinDeliveryReward: number;
    unrewardedAckGas: bigint;
    minAckReward: number;
    relativeMinAckReward: number;
    walletPublicKey: string;
}

export interface SubmitterWorkerData {
    chainId: string;
    rpc: string;
    relayerPrivateKey: string;
    incentivesAddresses: Map<string, string>;
    newOrdersDelay: number;
    retryInterval: number;
    processingInterval: number;
    maxTries: number;
    maxPendingTransactions: number;
    unrewardedDeliveryGas: bigint;
    minDeliveryReward: number;
    relativeMinDeliveryReward: number;
    unrewardedAckGas: bigint;
    minAckReward: number;
    relativeMinAckReward: number;
    pricingPort: MessagePort;
    walletPublicKey: string;
    walletPort: MessagePort;
    loggerOptions: LoggerOptions;
}

@Injectable()
export class SubmitterService {
    private readonly workers = new Map<string, Worker>();

    constructor(
        private readonly configService: ConfigService,
        private readonly pricingService: PricingService,
        private readonly walletService: WalletService,
        private readonly loggerService: LoggerService,
    ) {}

    async onModuleInit(): Promise<void> {
        this.loggerService.info(`Starting the submitter on all chains...`);

        const globalSubmitterConfig = this.loadGlobalSubmitterConfig();

        // check if the submitter has been disabled.
        if (!globalSubmitterConfig.enabled) {
            this.loggerService.info(`Submitter has been disabled. Ending init early`);
            return;
        }

        // Initialize the submitter states
        for (const [, chainConfig] of this.configService.chainsConfig) {
            // Load the worker chain override config or set the defaults if missing
            const workerData = await this.loadWorkerData(
                chainConfig,
                globalSubmitterConfig,
            );

            const worker = new Worker(join(__dirname, 'submitter.worker.js'), {
                workerData,
                transferList: [workerData.pricingPort, workerData.walletPort]
            });

            worker.on('error', (error) =>
                this.loggerService.fatal(
                    { error: tryErrorToString(error), chainId: chainConfig.chainId },
                    `Error on submitter worker.`,
                ),
            );

            worker.on('exit', (exitCode) =>
                this.loggerService.fatal(
                    { exitCode, chainId: chainConfig.chainId },
                    `Submitter worker exited.`,
                ),
            );

            this.workers.set(chainConfig.chainId, worker);
        }

        // Add a small delay to wait for the workers to be initialized
        //TODO the following should not be delay-based.
        await new Promise((r) => setTimeout(r, 5000));
    }

    private loadGlobalSubmitterConfig(): GlobalSubmitterConfig {
        const submitterConfig = this.configService.globalConfig.submitter;

        const enabled = submitterConfig['enabled'] ?? true;

        const newOrdersDelay =
            submitterConfig.newOrdersDelay ?? NEW_ORDERS_DELAY_DEFAULT;
        const retryInterval =
            submitterConfig.retryInterval ?? RETRY_INTERVAL_DEFAULT;
        const processingInterval =
            submitterConfig.processingInterval ?? PROCESSING_INTERVAL_DEFAULT;
        const maxTries = submitterConfig.maxTries ?? MAX_TRIES_DEFAULT;
        const maxPendingTransactions =
            submitterConfig.maxPendingTransactions ?? MAX_PENDING_TRANSACTIONS;

        const unrewardedDeliveryGas = 
            submitterConfig.unrewardedDeliveryGas ?? UNREWARDED_DELIVERY_GAS_DEFAULT;
        const minDeliveryReward =
            submitterConfig.minDeliveryReward ?? MIN_DELIVERY_REWARD_DEFAULT;
        const relativeMinDeliveryReward =
            submitterConfig.relativeMinDeliveryReward ?? RELATIVE_MIN_DELIVERY_REWARD_DEFAULT;
        const unrewardedAckGas = 
            submitterConfig.unrewardedAckGas ?? UNREWARDED_ACK_GAS_DEFAULT;
        const minAckReward =
            submitterConfig.minAckReward ?? MIN_ACK_REWARD_DEFAULT;
        const relativeMinAckReward =
            submitterConfig.relativeMinAckReward ?? RELATIVE_MIN_ACK_REWARD_DEFAULT;

        const walletPublicKey = (new Wallet(this.configService.globalConfig.privateKey)).address;

        return {
            enabled,
            newOrdersDelay,
            retryInterval,
            processingInterval,
            maxTries,
            maxPendingTransactions,
            walletPublicKey,
            unrewardedDeliveryGas,
            minDeliveryReward,
            relativeMinDeliveryReward,
            unrewardedAckGas,
            minAckReward,
            relativeMinAckReward,
        };
    }

    private async loadWorkerData(
        chainConfig: ChainConfig,
        globalConfig: GlobalSubmitterConfig,
    ): Promise<SubmitterWorkerData> {
        const chainId = chainConfig.chainId;
        const rpc = chainConfig.rpc;
        const relayerPrivateKey = this.configService.globalConfig.privateKey;

        const incentivesAddresses = new Map<string, string>();
        this.configService.ambsConfig.forEach((amb) => {
            const incentiveAddress = amb.getIncentivesAddress(chainConfig.chainId);
            if (incentiveAddress != undefined) {
                incentivesAddresses.set(
                    amb.name,
                    amb.getIncentivesAddress(chainConfig.chainId),
                );
            }
        });

        return {
            chainId,
            rpc,
            relayerPrivateKey,
            incentivesAddresses,

            newOrdersDelay:
                chainConfig.submitter.newOrdersDelay ?? globalConfig.newOrdersDelay,

            retryInterval:
                chainConfig.submitter.retryInterval ?? globalConfig.retryInterval,

            processingInterval:
                chainConfig.submitter.processingInterval ??
                globalConfig.processingInterval,

            maxTries: chainConfig.submitter.maxTries ?? globalConfig.maxTries,

            maxPendingTransactions:
                chainConfig.submitter.maxPendingTransactions ??
                globalConfig.maxPendingTransactions,
            
            unrewardedDeliveryGas:
                chainConfig.submitter.unrewardedDeliveryGas ??
                globalConfig.unrewardedDeliveryGas,
        
            minDeliveryReward:
                chainConfig.submitter.minDeliveryReward ??
                globalConfig.minDeliveryReward,

            relativeMinDeliveryReward:
                chainConfig.submitter.relativeMinDeliveryReward ??
                globalConfig.relativeMinDeliveryReward,
            
            unrewardedAckGas:
                chainConfig.submitter.unrewardedAckGas ??
                globalConfig.unrewardedAckGas,

            minAckReward:
                chainConfig.submitter.minAckReward ??
                globalConfig.minAckReward,

            relativeMinAckReward:
                chainConfig.submitter.relativeMinAckReward ??
                globalConfig.relativeMinAckReward,


            pricingPort: await this.pricingService.attachToPricing(),

            walletPublicKey: globalConfig.walletPublicKey,
            walletPort: await this.walletService.attachToWallet(chainId),
            loggerOptions: this.loggerService.loggerOptions,
        };
    }
}
