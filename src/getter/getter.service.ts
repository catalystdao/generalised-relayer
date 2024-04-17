import { Injectable, OnModuleInit } from '@nestjs/common';
import { join } from 'path';
import { Worker, MessagePort } from 'worker_threads';
import { ConfigService } from 'src/config/config.service';
import { ChainConfig } from 'src/config/config.types';
import { LoggerService, STATUS_LOG_INTERVAL } from 'src/logger/logger.service';
import { LoggerOptions } from 'pino';
import { tryErrorToString } from 'src/common/utils';
import { MonitorService } from 'src/monitor/monitor.service';

export const DEFAULT_GETTER_RETRY_INTERVAL = 2000;
export const DEFAULT_GETTER_PROCESSING_INTERVAL = 100;
export const DEFAULT_GETTER_MAX_BLOCKS = null;

interface GlobalGetterConfig {
  retryInterval: number;
  processingInterval: number;
  maxBlocks: number | null;
}

export interface GetterWorkerData {
  chainId: string;
  rpc: string;
  startingBlock?: number;
  stoppingBlock?: number;
  retryInterval: number;
  processingInterval: number;
  maxBlocks: number | null;
  incentivesAddresses: string[];
  monitorPort: MessagePort;
  loggerOptions: LoggerOptions;
}

@Injectable()
export class GetterService implements OnModuleInit {
  private workers: Record<string, Worker | null> = {};

  constructor(
    private readonly configService: ConfigService,
    private readonly monitorService: MonitorService,
    private readonly loggerService: LoggerService,
  ) {}

  async onModuleInit() {
    this.loggerService.info(`Starting Bounty Collection on all chains...`);

    await this.initializeWorkers();

    this.initiateIntervalStatusLog();
  }

  private async initializeWorkers(): Promise<void> {
    const globalGetterConfig = this.loadGlobalGetterConfig();

    for (const [chainId, chainConfig] of this.configService.chainsConfig) {
      const workerData = await this.loadWorkerData(chainConfig, globalGetterConfig);

      if (workerData.incentivesAddresses.length == 0) {
        this.loggerService.info(
          { chainId },
          'Skipping getter worker creation: no incentive address to listen for found.',
        );
        return;
      }

      const worker = new Worker(join(__dirname, 'getter.worker.js'), {
        workerData,
        transferList: [workerData.monitorPort]
      });
      this.workers[chainId] = worker;

      worker.on('error', (error) =>
        this.loggerService.fatal(
          { error: tryErrorToString(error), chainId: chainConfig.chainId },
          `Error on getter worker.`,
        ),
      );

      worker.on('exit', (exitCode) => {
        this.workers[chainConfig.chainId] = null;
        this.loggerService.info(
          { exitCode, chainId: chainConfig.chainId },
          `Getter worker exited.`,
        );
      });
    };
  }

  private loadGlobalGetterConfig(): GlobalGetterConfig {
    const globalConfig = this.configService.globalConfig;
    const globalGetterConfig = globalConfig.getter;

    const retryInterval = globalGetterConfig.retryInterval ?? DEFAULT_GETTER_RETRY_INTERVAL;
    const processingInterval = globalGetterConfig.processingInterval ?? DEFAULT_GETTER_PROCESSING_INTERVAL;
    const maxBlocks = globalGetterConfig.maxBlocks ?? DEFAULT_GETTER_MAX_BLOCKS;

    return {
      retryInterval,
      processingInterval,
      maxBlocks
    };
  }

  private async loadWorkerData(
    chainConfig: ChainConfig,
    defaultConfig: GlobalGetterConfig,
  ): Promise<GetterWorkerData> {
    const chainId = chainConfig.chainId;

    const incentivesAddresses = Array.from(
      this.configService.ambsConfig.values(),
    )
      .map((amb) => amb.getIncentivesAddress(chainId))
      .filter((address) => address != undefined);

    return {
      chainId,
      rpc: chainConfig.rpc,
      startingBlock: chainConfig.startingBlock,
      stoppingBlock: chainConfig.stoppingBlock,
      retryInterval: chainConfig.getter.retryInterval ?? defaultConfig.retryInterval,
      processingInterval: chainConfig.getter.processingInterval ?? defaultConfig.processingInterval,
      maxBlocks: chainConfig.getter.maxBlocks ?? defaultConfig.maxBlocks,
      incentivesAddresses,
      monitorPort: await this.monitorService.attachToMonitor(chainId),
      loggerOptions: this.loggerService.loggerOptions,
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
      this.loggerService.info(status, 'Getter workers status.');
    };
    setInterval(logStatus, STATUS_LOG_INTERVAL);
  }
}
