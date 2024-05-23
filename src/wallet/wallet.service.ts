import { Global, Injectable, OnModuleInit } from '@nestjs/common';
import { join } from 'path';
import { LoggerOptions } from 'pino';
import { Worker, MessagePort, MessageChannel } from 'worker_threads';
import { ConfigService } from 'src/config/config.service';
import { LoggerService, STATUS_LOG_INTERVAL } from 'src/logger/logger.service';
import { WalletServiceRoutingMessage, WalletTransactionRequestMessage } from './wallet.types';
import { Wallet } from 'ethers6';
import { tryErrorToString } from 'src/common/utils';

const DEFAULT_WALLET_RETRY_INTERVAL = 30000;
const DEFAULT_WALLET_PROCESSING_INTERVAL = 100;
const DEFAULT_WALLET_MAX_TRIES = 3;
const DEFAULT_WALLET_MAX_PENDING_TRANSACTIONS = 50;
const DEFAULT_WALLET_CONFIRMATIONS = 1;
const DEFAULT_WALLET_CONFIRMATION_TIMEOUT = 60000;
const DEFAULT_WALLET_BALANCE_UPDATE_INTERVAL = 50;

interface DefaultWalletWorkerData {
    retryInterval: number;
    processingInterval: number;
    maxTries: number;
    maxPendingTransactions: number;
    confirmations: number;
    confirmationTimeout: number;
    lowBalanceWarning: bigint | undefined;
    balanceUpdateInterval: number;
    maxFeePerGas?: bigint;
    maxAllowedPriorityFeePerGas?: bigint;
    maxPriorityFeeAdjustmentFactor?: number;
    maxAllowedGasPrice?: bigint;
    gasPriceAdjustmentFactor?: number;
    priorityAdjustmentFactor?: number;
}

export interface WalletWorkerData {
    chainId: string,
    chainName: string,
    rpc: string,
    retryInterval: number;
    processingInterval: number;
    maxTries: number;
    maxPendingTransactions: number;
    confirmations: number;
    confirmationTimeout: number;
    privateKey: string;
    lowBalanceWarning: bigint | undefined;
    balanceUpdateInterval: number;
    maxFeePerGas?: bigint;
    maxAllowedPriorityFeePerGas?: bigint;
    maxPriorityFeeAdjustmentFactor?: number;
    maxAllowedGasPrice?: bigint;
    gasPriceAdjustmentFactor?: number;
    priorityAdjustmentFactor?: number;
    loggerOptions: LoggerOptions;

}

@Global()
@Injectable()
export class WalletService implements OnModuleInit {
    private workers: Record<string, Worker | null> = {};
    private portsCount = 0;
    private readonly ports: Record<number, MessagePort> = {};

    readonly publicKey: string;

    constructor(
        private readonly configService: ConfigService,
        private readonly loggerService: LoggerService,
    ) {
        this.publicKey = (new Wallet(this.configService.globalConfig.privateKey)).address;
    }

    async onModuleInit() {
        this.loggerService.info(`Starting Wallets on all chains...`);

        await this.initializeWorkers();

        this.initiateIntervalStatusLog();
    }

    private async initializeWorkers(): Promise<void> {
        const defaultWorkerConfig = this.loadDefaultWorkerConfig();

        for (const [chainId,] of this.configService.chainsConfig) {

            const workerData = this.loadWorkerConfig(chainId, defaultWorkerConfig);

            const worker = new Worker(join(__dirname, 'wallet.worker.js'), {
                workerData
            });
            this.workers[chainId] = worker;

            worker.on('error', (error) =>
                this.loggerService.fatal(
                    { error: tryErrorToString(error), chainId },
                    `Error on wallet worker.`,
                ),
            );

            worker.on('exit', (exitCode) => {
                this.workers[chainId] = null;
                this.loggerService.fatal(
                    { exitCode, chainId },
                    `Wallet worker exited.`,
                );
            });

            worker.on('message', (message: WalletServiceRoutingMessage) => {
                const port = this.ports[message.portId];
                if (port == undefined) {
                    this.loggerService.error(
                        message,
                        `Unable to route transaction response on wallet: port id not found.`
                    );
                    return;
                }

                port.postMessage(message.data);
            })
        }

        // Add a small delay to wait for the workers to be initialized
        //TODO the following should not be delay-based.
        //TODO is this required?
        await new Promise((r) => setTimeout(r, 5000));
    }

    private loadDefaultWorkerConfig(): DefaultWalletWorkerData {
        const globalWalletConfig = this.configService.globalConfig.wallet;

        const retryInterval = globalWalletConfig.retryInterval ?? DEFAULT_WALLET_RETRY_INTERVAL;
        const processingInterval = globalWalletConfig.processingInterval ?? DEFAULT_WALLET_PROCESSING_INTERVAL;
        const maxTries = globalWalletConfig.maxTries ?? DEFAULT_WALLET_MAX_TRIES;
        const maxPendingTransactions = globalWalletConfig.maxPendingTransactions ?? DEFAULT_WALLET_MAX_PENDING_TRANSACTIONS;
        const confirmations = globalWalletConfig.confirmations ?? DEFAULT_WALLET_CONFIRMATIONS;
        const confirmationTimeout = globalWalletConfig.confirmationTimeout ?? DEFAULT_WALLET_CONFIRMATION_TIMEOUT;
        const lowBalanceWarning = globalWalletConfig.lowGasBalanceWarning;
        const balanceUpdateInterval = globalWalletConfig.gasBalanceUpdateInterval ?? DEFAULT_WALLET_BALANCE_UPDATE_INTERVAL;

        const maxFeePerGas = globalWalletConfig.maxFeePerGas;
        const maxAllowedPriorityFeePerGas = globalWalletConfig.maxAllowedPriorityFeePerGas;
        const maxPriorityFeeAdjustmentFactor = globalWalletConfig.maxPriorityFeeAdjustmentFactor;
        const maxAllowedGasPrice = globalWalletConfig.maxAllowedGasPrice;
        const gasPriceAdjustmentFactor = globalWalletConfig.gasPriceAdjustmentFactor;
        const priorityAdjustmentFactor = globalWalletConfig.priorityAdjustmentFactor;

        return {
            retryInterval,
            processingInterval,
            maxTries,
            maxPendingTransactions,
            confirmations,
            confirmationTimeout,
            lowBalanceWarning,
            balanceUpdateInterval,
            maxFeePerGas,
            maxAllowedPriorityFeePerGas,
            maxPriorityFeeAdjustmentFactor,
            maxAllowedGasPrice,
            gasPriceAdjustmentFactor,
            priorityAdjustmentFactor,
        }
    }

    private loadWorkerConfig(
        chainId: string,
        defaultConfig: DefaultWalletWorkerData
    ): WalletWorkerData {

        const chainConfig = this.configService.chainsConfig.get(chainId);
        if (chainConfig == undefined) {
            throw new Error(`Unable to load config for chain ${chainId}`);
        }

        const chainWalletConfig = chainConfig.wallet;
        return {
            chainId,
            chainName: chainConfig.name,
            rpc: chainWalletConfig.rpc ?? chainConfig.rpc,

            retryInterval: chainWalletConfig.retryInterval ?? defaultConfig.retryInterval,
            processingInterval:
                chainWalletConfig.processingInterval ??
                defaultConfig.processingInterval,
            maxTries: chainWalletConfig.maxTries ?? defaultConfig.maxTries,
            maxPendingTransactions:
                chainWalletConfig.maxPendingTransactions
                ?? defaultConfig.maxPendingTransactions,
            confirmations: chainWalletConfig.confirmations ?? defaultConfig.confirmations,
            confirmationTimeout:
                chainWalletConfig.confirmationTimeout ??
                defaultConfig.confirmationTimeout,
            lowBalanceWarning:
                chainWalletConfig.lowGasBalanceWarning ??
                defaultConfig.lowBalanceWarning,
            balanceUpdateInterval:
                chainWalletConfig.gasBalanceUpdateInterval ??
                defaultConfig.balanceUpdateInterval,

            privateKey: this.configService.globalConfig.privateKey,

            maxFeePerGas:
                chainWalletConfig.maxFeePerGas ??
                defaultConfig.maxFeePerGas,

            maxPriorityFeeAdjustmentFactor:
                chainWalletConfig.maxPriorityFeeAdjustmentFactor ??
                defaultConfig.maxPriorityFeeAdjustmentFactor,

            maxAllowedPriorityFeePerGas:
                chainWalletConfig.maxAllowedPriorityFeePerGas ??
                defaultConfig.maxAllowedPriorityFeePerGas,

            gasPriceAdjustmentFactor:
                chainWalletConfig.gasPriceAdjustmentFactor ??
                defaultConfig.gasPriceAdjustmentFactor,

            maxAllowedGasPrice:
                chainWalletConfig.maxAllowedGasPrice ??
                defaultConfig.maxAllowedGasPrice,

            priorityAdjustmentFactor:
                chainWalletConfig.priorityAdjustmentFactor ??
                defaultConfig.priorityAdjustmentFactor,

            loggerOptions: this.loggerService.loggerOptions
        };
    }

    private initiateIntervalStatusLog(): void {
        const logStatus = () => {
            const activeWorkers = [];
            const inactiveWorkers = [];
            for (const chainId of Object.keys(this.workers)) {
                if (this.workers[chainId] != null) activeWorkers.push(chainId);
                else inactiveWorkers.push(chainId);
            }
            const status = {
                activeWorkers,
                inactiveWorkers,
            };
            this.loggerService.info(status, 'Wallet workers status.');
        };
        setInterval(logStatus, STATUS_LOG_INTERVAL);
    }

    async attachToWallet(chainId: string): Promise<MessagePort> {
        const worker = this.workers[chainId];

        if (worker == undefined) {
            throw new Error(`Wallet does not exist for chain ${chainId}`);
        }
        
        const portId = this.portsCount++;

        const { port1, port2 } = new MessageChannel();

        port1.on('message', (message: WalletTransactionRequestMessage) => {
            const routingMessage: WalletServiceRoutingMessage = {
                portId,
                data: message
            };
            worker.postMessage(routingMessage);
        });

        this.ports[portId] = port1;

        return port2;
    }
}
