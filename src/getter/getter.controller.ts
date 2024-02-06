import { Controller, OnModuleInit } from '@nestjs/common';
import { join } from 'path';
// import { bountyToDTO } from 'src/common/utils';
import { Worker } from 'worker_threads';
import { ChainConfig, ConfigService } from 'src/config/config.service';
import { LoggerService, STATUS_LOG_INTERVAL } from 'src/logger/logger.service';
import { LoggerOptions } from 'pino';

export const DEFAULT_GETTER_INTERVAL = 5000;
export const DEFAULT_GETTER_BLOCK_DELAY = 0;
export const DEFAULT_GETTER_MAX_BLOCKS = null;

interface GlobalGetterConfig {
  blockDelay: number;
  interval: number;
  maxBlocks: number | null;
}

export interface GetterWorkerData {
  chainId: string;
  rpc: string;
  startingBlock?: number;
  stoppingBlock?: number;
  blockDelay: number;
  interval: number;
  maxBlocks: number | null;
  incentivesAddresses: string[];
  loggerOptions: LoggerOptions;
}

@Controller()
export class GetterController implements OnModuleInit {
  private workers: Record<string, Worker | null> = {};

  constructor(
    private readonly configService: ConfigService,
    private readonly loggerService: LoggerService,
  ) {}

  onModuleInit() {
    this.loggerService.info(`Starting Bounty Collection on all chains...`);

    this.initializeWorkers();

    this.initiateIntervalStatusLog();
  }

  private initializeWorkers(): void {
    const globalGetterConfig = this.loadGlobalGetterConfig();

    this.configService.chainsConfig.forEach((chainConfig) => {
      const chainId = chainConfig.chainId;
      const workerData = this.loadWorkerData(chainConfig, globalGetterConfig);

      const worker = new Worker(join(__dirname, 'getter.service.js'), {
        workerData,
      });
      this.workers[chainId] = worker;

      worker.on('error', (error) =>
        this.loggerService.fatal(
          { error, chainId: chainConfig.chainId },
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
    });
  }

  private loadGlobalGetterConfig(): GlobalGetterConfig {
    const globalConfig = this.configService.globalConfig;
    const globalGetterConfig = globalConfig.getter;

    const blockDelay = globalConfig.blockDelay ?? DEFAULT_GETTER_BLOCK_DELAY;
    const interval = globalGetterConfig.interval ?? DEFAULT_GETTER_INTERVAL;
    const maxBlocks = globalGetterConfig.maxBlocks ?? DEFAULT_GETTER_MAX_BLOCKS;

    return {
      interval,
      blockDelay,
      maxBlocks,
    };
  }

  private loadWorkerData(
    chainConfig: ChainConfig,
    defaultConfig: GlobalGetterConfig,
  ): GetterWorkerData {
    const chainId = chainConfig.chainId;

    const incentivesAddresses = Array.from(
      this.configService.ambsConfig.values(),
    ).map((amb) => amb.getIncentivesAddress(chainId));

    return {
      chainId,
      rpc: chainConfig.rpc,
      startingBlock: chainConfig.startingBlock,
      stoppingBlock: chainConfig.stoppingBlock,
      blockDelay: chainConfig.blockDelay ?? defaultConfig.blockDelay,
      interval: chainConfig.getter.interval ?? defaultConfig.interval,
      maxBlocks: chainConfig.getter.maxBlocks ?? defaultConfig.maxBlocks,
      incentivesAddresses,
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
