import { Global, Injectable, OnModuleInit } from '@nestjs/common';
import { join } from 'path';
import { LoggerOptions } from 'pino';
import { Worker, MessagePort, MessageChannel } from 'worker_threads';
import { ConfigService } from 'src/config/config.service';
import { LoggerService, STATUS_LOG_INTERVAL } from 'src/logger/logger.service';
import { WALLET_WORKER_CRASHED_MESSAGE_ID, WalletCrashedMessage, WalletMessageType, WalletPortData, WalletServiceRoutingData } from './wallet.types';
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
    private readonly defaultWorkerConfig: DefaultWalletWorkerData;

    private workers: Record<string, Worker | null> = {};
    private portsCount = 0;
    private readonly ports: Record<number, MessagePort> = {};

    private readonly queuedMessages: Record<string, WalletServiceRoutingData[]> = {};

    readonly publicKey: string;

    constructor(
        private readonly configService: ConfigService,
        private readonly loggerService: LoggerService,
    ) {
        this.defaultWorkerConfig = this.loadDefaultWorkerConfig();
        this.publicKey = (new Wallet(this.configService.globalConfig.privateKey)).address;
    }

    async onModuleInit() {
        this.loggerService.info(`Starting Wallets on all chains...`);

        await this.initializeWorkers();

        this.initiateIntervalStatusLog();
    }

    private async initializeWorkers(): Promise<void> {

        for (const [chainId,] of this.configService.chainsConfig) {
            this.spawnWorker(chainId);
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
    ): WalletWorkerData {

        const defaultConfig = this.defaultWorkerConfig;

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

    private spawnWorker(
        chainId: string
    ): void {
        const workerData = this.loadWorkerConfig(chainId);
        this.loggerService.info(
            {
                chainId,
                workerData,
            },
            `Spawning wallet worker.`
        );

        const worker = new Worker(join(__dirname, 'wallet.worker.js'), {
            workerData
        });
        this.workers[chainId] = worker;

        worker.on('error', (error) =>
            this.loggerService.error(
                { error: tryErrorToString(error), chainId },
                `Error on wallet worker.`,
            ),
        );

        worker.on('exit', (exitCode) => {
            this.workers[chainId] = null;
            this.loggerService.error(
                { exitCode, chainId },
                `Wallet worker exited.`,
            );

            this.abortPendingRequests(chainId);
            this.spawnWorker(chainId);
            this.recoverQueuedMessages(chainId);
        });

        worker.on('message', (routingData: WalletServiceRoutingData) => {
            const port = this.ports[routingData.portId];
            if (port == undefined) {
                this.loggerService.error(
                    { routingData },
                    `Unable to route transaction response on wallet: port id not found.`
                );
                return;
            }

            const portData: WalletPortData = {
                chainId,
                messageId: routingData.messageId,
                message: routingData.message,
            };

            port.postMessage(portData);
        });
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

    async attachToWallet(): Promise<MessagePort> {
        
        const portId = this.portsCount++;

        const { port1, port2 } = new MessageChannel();

        port1.on('message', (portData: WalletPortData) => {
            this.handleWalletPortData(
                portId,
                portData,
            );
        });

        this.ports[portId] = port1;

        return port2;
    }

    private handleWalletPortData(
        portId: number,
        portData: WalletPortData,
    ): void {
        const chainId = portData.chainId;
        const worker = this.workers[chainId];

        const routingData: WalletServiceRoutingData = {
            portId,
            messageId: portData.messageId,
            message: portData.message,
        };

        if (worker == undefined) {
            this.loggerService.warn(
                {
                    chainId,
                    portId,
                    message: portData.message
                },
                `Wallet does not exist for the requested chain. Queueing message.`
            );

            if (!(chainId in this.queuedMessages)) {
                this.queuedMessages[chainId] = [];
            }
            this.queuedMessages[chainId]!.push(routingData);
        } else {
            worker.postMessage(routingData);
        }
    }

    private abortPendingRequests(
        chainId: string,
    ): void {
        const message: WalletCrashedMessage = {
            type: WalletMessageType.WalletCrashed,
        };

        const walletCrashBroadcast: WalletPortData = {
            chainId,
            messageId: WALLET_WORKER_CRASHED_MESSAGE_ID,
            message,
        }

        for (const port of Object.values(this.ports)) {
            port.postMessage(walletCrashBroadcast);
        }
    }

    private recoverQueuedMessages(
        chainId: string,
    ): void {
        const queuedMessages = this.queuedMessages[chainId] ?? [];
        this.queuedMessages[chainId] = [];

        this.loggerService.info(
            {
                chainId,
                count: queuedMessages.length,
            },
            `Recovering queued wallet requests.`
        );

        for (const queuedMessage of queuedMessages) {
            this.handleWalletPortData(
                queuedMessage.portId,
                {
                    chainId,
                    messageId: queuedMessage.messageId,
                    message: queuedMessage.message,
                },
            );
        }
    }
}
