import { Injectable } from '@nestjs/common';
import { join } from 'path';
import { Worker } from 'worker_threads';
import { ConfigService } from 'src/config/config.service';
import { ChainConfig } from 'src/config/config.types';
import { LoggerService } from 'src/logger/logger.service';
import { LoggerOptions } from 'pino';

const RETRY_INTERVAL_DEFAULT = 30000;
const PROCESSING_INTERVAL_DEFAULT = 100;
const MAX_TRIES_DEFAULT = 3;
const MAX_PENDING_TRANSACTIONS = 50;
const NEW_ORDERS_DELAY_DEFAULT = 0;
const CONFIRMATIONS_DEFAULT = 1;
const CONFIRMATION_TIMEOUT_DEFAULT = 60000;
const BALANCE_UPDATE_INTERVAL_DEFAULT = 50;

interface GlobalSubmitterConfig {
  enabled: boolean;
  newOrdersDelay: number;
  retryInterval: number;
  processingInterval: number;
  maxTries: number;
  maxPendingTransactions: number;
  confirmations: number;
  confirmationTimeout: number;
  lowBalanceWarning: number | undefined;
  balanceUpdateInterval: number;
  gasLimitBuffer: Record<string, number> & { default?: number };
  maxFeePerGas?: number | string;
  maxAllowedPriorityFeePerGas?: number | string;
  maxPriorityFeeAdjustmentFactor?: number;
  maxAllowedGasPrice?: number | string;
  gasPriceAdjustmentFactor?: number;
  priorityAdjustmentFactor?: number;
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
  confirmations: number;
  confirmationTimeout: number;
  gasLimitBuffer: Record<string, number>;
  lowBalanceWarning: number | undefined;
  balanceUpdateInterval: number;
  maxFeePerGas?: number | string;
  maxAllowedPriorityFeePerGas?: number | string;
  maxPriorityFeeAdjustmentFactor?: number;
  maxAllowedGasPrice?: number | string;
  gasPriceAdjustmentFactor?: number;
  priorityAdjustmentFactor?: number;
  loggerOptions: LoggerOptions;
}

@Injectable()
export class SubmitterService {
  private readonly workers = new Map<string, Worker>();

  constructor(
    private readonly configService: ConfigService,
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
      const workerData = this.loadWorkerData(
        chainConfig,
        globalSubmitterConfig,
      );

      const worker = new Worker(join(__dirname, 'submitter.worker.js'), {
        workerData,
      });

      worker.on('error', (error) =>
        this.loggerService.fatal(
          { error, chainId: chainConfig.chainId },
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
    const confirmations =
      submitterConfig.confirmations ?? CONFIRMATIONS_DEFAULT;
    const confirmationTimeout =
      submitterConfig.confirmationTimeout ?? CONFIRMATION_TIMEOUT_DEFAULT;
    const lowBalanceWarning = submitterConfig.lowBalanceWarning;
    const balanceUpdateInterval =
      submitterConfig.balanceUpdateInterval ?? BALANCE_UPDATE_INTERVAL_DEFAULT;

    const gasLimitBuffer = submitterConfig.gasLimitBuffer ?? {};
    if (!('default' in gasLimitBuffer)) {
      gasLimitBuffer['default'] = 0;
    }
    const maxFeePerGas = submitterConfig.maxFeePerGas;
    const maxAllowedPriorityFeePerGas =
      submitterConfig.maxAllowedPriorityFeePerGas;
    const maxPriorityFeeAdjustmentFactor =
      submitterConfig.maxPriorityFeeAdjustmentFactor;
    const maxAllowedGasPrice = submitterConfig.maxAllowedGasPrice;
    const gasPriceAdjustmentFactor = submitterConfig.gasPriceAdjustmentFactor;
    const priorityAdjustmentFactor = submitterConfig.priorityAdjustmentFactor;

    return {
      enabled,
      newOrdersDelay,
      retryInterval,
      processingInterval,
      maxTries,
      maxPendingTransactions,
      confirmations,
      confirmationTimeout,
      lowBalanceWarning,
      balanceUpdateInterval,
      gasLimitBuffer,
      maxFeePerGas,
      maxAllowedPriorityFeePerGas,
      maxPriorityFeeAdjustmentFactor,
      maxAllowedGasPrice,
      gasPriceAdjustmentFactor,
      priorityAdjustmentFactor,
    };
  }

  private loadWorkerData(
    chainConfig: ChainConfig,
    globalConfig: GlobalSubmitterConfig,
  ): SubmitterWorkerData {
    const chainId = chainConfig.chainId;
    const rpc = chainConfig.rpc;
    const relayerPrivateKey = this.configService.globalConfig.privateKey;

    const incentivesAddresses = new Map<string, string>();
    this.configService.ambsConfig.forEach((amb) =>
      incentivesAddresses.set(
        amb.name,
        amb.getIncentivesAddress(chainConfig.chainId),
      ),
    );

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

      confirmations:
        chainConfig.submitter.confirmations ?? globalConfig.confirmations,

      confirmationTimeout:
        chainConfig.submitter.confirmationTimeout ??
        globalConfig.confirmationTimeout,

      gasLimitBuffer: this.getChainGasLimitBufferConfig(
        globalConfig.gasLimitBuffer,
        chainConfig.submitter.gasLimitBuffer ?? {},
      ),

      maxFeePerGas:
        chainConfig.submitter.maxFeePerGas ?? globalConfig.maxFeePerGas,

      maxPriorityFeeAdjustmentFactor:
        chainConfig.submitter.maxPriorityFeeAdjustmentFactor ??
        globalConfig.maxPriorityFeeAdjustmentFactor,

      maxAllowedPriorityFeePerGas:
        chainConfig.submitter.maxAllowedPriorityFeePerGas ??
        globalConfig.maxAllowedPriorityFeePerGas,

      gasPriceAdjustmentFactor:
        chainConfig.submitter.gasPriceAdjustmentFactor ??
        globalConfig.gasPriceAdjustmentFactor,

      maxAllowedGasPrice:
        chainConfig.submitter.maxAllowedGasPrice ??
        globalConfig.maxAllowedGasPrice,

      priorityAdjustmentFactor:
        chainConfig.submitter.priorityAdjustmentFactor ??
        globalConfig.priorityAdjustmentFactor,

      lowBalanceWarning:
        chainConfig.submitter.lowBalanceWarning ??
        globalConfig.lowBalanceWarning,

      balanceUpdateInterval:
        chainConfig.submitter.balanceUpdateInterval ??
        globalConfig.balanceUpdateInterval,

      loggerOptions: this.loggerService.loggerOptions,
    };
  }

  private getChainGasLimitBufferConfig(
    defaultGasLimitBufferConfig: Record<string, number>,
    chainGasLimitBufferConfig: Record<string, number>,
  ): Record<string, number> {
    const gasLimitBuffers: Record<string, number> = {};

    // Apply defaults
    for (const key in defaultGasLimitBufferConfig) {
      gasLimitBuffers[key] = defaultGasLimitBufferConfig[key];
    }

    // Apply chain overrides
    for (const key in chainGasLimitBufferConfig) {
      gasLimitBuffers[key] = chainGasLimitBufferConfig[key];
    }

    return gasLimitBuffers;
  }
}
