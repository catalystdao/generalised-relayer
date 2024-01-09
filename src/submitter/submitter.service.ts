import { Injectable } from '@nestjs/common';
import { join } from 'path';
import { Worker } from 'worker_threads';
import { ConfigService } from 'src/config/config.service';
import { LoggerService } from 'src/logger/logger.service';

const RETRY_INTERVAL_DEFAULT = 2000;
const PROCESSING_INTERVAL_DEFAULT = 100;
const MAX_TRIES_DEFAULT = 3;
const MAX_PENDING_TRANSACTIONS = 1000;
const NEW_ORDERS_DELAY_DEFAULT = 0;
const TRANSACTION_TIMEOUT_DEFAULT = 10 * 60000;

export interface SubmitterWorkerConfig {
  retryInterval: number;
  processingInterval: number;
  maxTries: number;
  enabled?: boolean;
  gasLimitBuffer: Record<string, number>;
  newOrdersDelay: number;
  maxPendingTransactions: number;
  transactionTimeout: number;
  maxFeePerGas: number | undefined;
  maxPriorityFeeAdjustmentFactor: number | undefined;
  maxAllowedPriorityFeePerGas: number | undefined;
  gasPriceAdjustmentFactor: number | undefined;
  maxAllowedGasPrice: number | undefined;
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

    const defaultWorkerConfig: SubmitterWorkerConfig =
      this.loadDefaultWorkerConfig();

    // check if the submitter has been disabled.
    if (!defaultWorkerConfig.enabled) {
      this.loggerService.info(`Submittor has been disabled. Ending init early`);
      return;
    }

    // Initialize the submitter states
    for (const [, chainConfig] of this.configService.chainsConfig) {
      const incentivesAddresses = new Map<string, string>();
      this.configService.ambsConfig.forEach((amb) =>
        incentivesAddresses.set(
          amb.name,
          amb.getIncentivesAddress(chainConfig.chainId),
        ),
      );

      // Load the worker chain override config or set the defaults if missing
      const workerConfig: SubmitterWorkerConfig = {
        retryInterval:
          chainConfig.submitter.retryInterval ??
          defaultWorkerConfig.retryInterval,
        processingInterval:
          chainConfig.submitter.processingInterval ??
          defaultWorkerConfig.processingInterval,
        maxTries:
          chainConfig.submitter.maxTries ?? defaultWorkerConfig.maxTries,
        gasLimitBuffer: this.getChainGasLimitBufferConfig(
          defaultWorkerConfig.gasLimitBuffer,
          chainConfig.submitter['gasLimitBuffer'] ?? {},
        ),
        newOrdersDelay:
          chainConfig.submitter.newOrdersDelay ??
          defaultWorkerConfig.newOrdersDelay,
        maxPendingTransactions:
          chainConfig.submitter.maxPendingTransactions ??
          defaultWorkerConfig.maxPendingTransactions,
        transactionTimeout:
          chainConfig.submitter.transactionTimeout ??
          defaultWorkerConfig.transactionTimeout,
        maxFeePerGas: chainConfig.submitter.maxFeePerGas,
        maxPriorityFeeAdjustmentFactor:
          chainConfig.submitter.maxPriorityFeeAdjustmentFactor,
        maxAllowedPriorityFeePerGas:
          chainConfig.submitter.maxAllowedPriorityFeePerGas,
        gasPriceAdjustmentFactor:
          chainConfig.submitter.gasPriceAdjustmentFactor,
        maxAllowedGasPrice: chainConfig.submitter.maxAllowedGasPrice,
      };

      const worker = new Worker(join(__dirname, 'submitter.worker.js'), {
        workerData: {
          chainConfig,
          workerConfig,
          relayerPrivateKey: this.configService.relayerConfig.privateKey,
          incentivesAddresses,
          loggerOptions: this.loggerService.loggerOptions,
        },
      });

      worker.on('error', (error) =>
        this.loggerService.fatal(
          error,
          `Error on submitter worker (chain ${chainConfig.chainId}).`,
        ),
      );

      worker.on('exit', (exitCode) =>
        this.loggerService.fatal(
          `Submitter worker exited with code ${exitCode} (chain ${chainConfig.chainId}).`,
        ),
      );

      this.workers.set(chainConfig.chainId, worker);
    }
  }

  private loadDefaultWorkerConfig(): SubmitterWorkerConfig {
    const submitterConfig = this.configService.relayerConfig.submitter;

    if (submitterConfig['retryInterval'] == undefined) {
      this.loggerService.warn(
        `No 'submitter: retryInterval' configuration set. Defaulting to ${RETRY_INTERVAL_DEFAULT}`,
      );
    }
    const retryInterval =
      submitterConfig['retryInterval'] ?? RETRY_INTERVAL_DEFAULT;

    const enabled = submitterConfig['enabled'] ?? true;

    if (submitterConfig['processingInterval'] == undefined) {
      this.loggerService.warn(
        `No 'submitter: processingInterval' configuration set. Defaulting to ${PROCESSING_INTERVAL_DEFAULT}`,
      );
    }
    const processingInterval =
      submitterConfig['processingInterval'] ?? PROCESSING_INTERVAL_DEFAULT;

    if (submitterConfig['maxTries'] == undefined) {
      this.loggerService.warn(
        `No 'submitter: maxTries' configuration set. Defaulting to ${MAX_TRIES_DEFAULT}`,
      );
    }
    const maxTries = submitterConfig['maxTries'] ?? MAX_TRIES_DEFAULT;

    if (submitterConfig['newOrdersDelay'] == undefined) {
      this.loggerService.warn(
        `No 'submitter: newOrdersDelay' configuration set. Defaulting to ${NEW_ORDERS_DELAY_DEFAULT}`,
      );
    }
    const newOrdersDelay =
      submitterConfig['newOrdersDelay'] ?? NEW_ORDERS_DELAY_DEFAULT;

    if (submitterConfig['maxPendingTransactions'] == undefined) {
      this.loggerService.warn(
        `No 'submitter: maxPendingTransactions' configuration set. Defaulting to ${MAX_PENDING_TRANSACTIONS}`,
      );
    }
    const maxPendingTransactions =
      submitterConfig['maxPendingTransactions'] ?? MAX_PENDING_TRANSACTIONS;

    if (submitterConfig['transactionTimeout'] == undefined) {
      this.loggerService.warn(
        `No 'submitter: transactionTimeout' configuration set. Defaulting to ${TRANSACTION_TIMEOUT_DEFAULT}`,
      );
    }
    const transactionTimeout =
      submitterConfig['transactionTimeout'] ?? TRANSACTION_TIMEOUT_DEFAULT;

    const gasLimitBuffer = submitterConfig['gasLimitBuffer'] ?? {};
    if (!('default' in gasLimitBuffer)) {
      gasLimitBuffer['default'] = 0;
    }

    return {
      retryInterval,
      processingInterval,
      maxTries,
      enabled,
      gasLimitBuffer,
      maxPendingTransactions,
      newOrdersDelay,
      transactionTimeout,
      // Never load default gas fee configuration
      maxFeePerGas: undefined,
      maxPriorityFeeAdjustmentFactor: undefined,
      maxAllowedPriorityFeePerGas: undefined,
      maxAllowedGasPrice: undefined,
      gasPriceAdjustmentFactor: undefined,
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

  // TODO: implement with redis
  // async submitWithoutEvaluating(
  //   amb: string,
  //   messageIdentifier: string,
  //   destinationChainId: string,
  //   rawMessage: string,
  //   messagingctx: BytesLike = ethers.constants.HashZero,
  // ) {
  //   const worker = this.workers.get(destinationChainId);

  //   if (worker == undefined) {
  //     this.loggerService.warn(
  //       `Unable to submit priority message ${messageIdentifier} on chain ${destinationChainId}. Unsupported target chain.`,
  //     );
  //     return;
  //   }

  //   worker.postMessage({
  //     amb,
  //     messageIdentifier,
  //     message: rawMessage,
  //     messageContext: messagingctx,
  //     priority: true,
  //   });
  // }
}
