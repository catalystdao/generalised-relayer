import { join } from 'path';
import { Worker } from 'worker_threads';
import { CollectorModuleInterface } from '../collector.controller';
import {
  DEFAULT_GETTER_BLOCK_DELAY,
  DEFAULT_GETTER_INTERVAL,
  DEFAULT_GETTER_MAX_BLOCKS,
} from 'src/getter/getter.controller';
import { LoggerService, STATUS_LOG_INTERVAL } from 'src/logger/logger.service';
import { ConfigService } from 'src/config/config.service';
import { ChainConfig } from 'src/config/config.types';
import { LoggerOptions } from 'pino';

interface GlobalPolymerConfig {
  blockDelay: number;
  interval: number;
  maxBlocks: number | null;
}

export interface PolymerWorkerData {
  chainId: string;
  rpc: string;
  startingBlock?: number;
  stoppingBlock?: number;
  blockDelay: number;
  interval: number;
  maxBlocks: number | null;
  incentivesAddress: string;
  loggerOptions: LoggerOptions;
  polymerAddress: string;
}

function loadGlobalPolymerConfig(
  configService: ConfigService,
): GlobalPolymerConfig {
  const polymerConfig = configService.ambsConfig.get('polymer');
  if (polymerConfig == undefined) {
    throw Error(
      `Failed to load Polymer module: 'polymer' configuration not found.`,
    );
  }

  const blockDelay =
    configService.globalConfig.blockDelay ?? DEFAULT_GETTER_BLOCK_DELAY;

  const getterConfig = configService.globalConfig.getter;
  const interval = getterConfig.interval ?? DEFAULT_GETTER_INTERVAL;
  const maxBlocks = getterConfig.maxBlocks ?? DEFAULT_GETTER_MAX_BLOCKS;

  return {
    blockDelay,
    interval,
    maxBlocks,
  };
}

function loadWorkerData(
  configService: ConfigService,
  loggerService: LoggerService,
  chainConfig: ChainConfig,
  globalConfig: GlobalPolymerConfig,
): PolymerWorkerData | undefined {
  const chainId = chainConfig.chainId;
  const rpc = chainConfig.rpc;

  const incentivesAddress = configService.getAMBConfig(
    'polymer',
    'incentivesAddress',
    chainId,
  ) as string;

  const polymerAddress = configService.getAMBConfig(
    'wormhole',
    'bridgeAddress',
    chainConfig.chainId,
  ) as string | undefined;

  if (polymerAddress === undefined) return undefined;

  return {
    chainId,
    rpc,
    startingBlock: chainConfig.startingBlock,
    stoppingBlock: chainConfig.stoppingBlock,
    blockDelay: chainConfig.blockDelay ?? globalConfig.blockDelay,
    interval: chainConfig.getter.interval ?? globalConfig.interval,
    maxBlocks: chainConfig.getter.maxBlocks ?? globalConfig.maxBlocks,
    incentivesAddress,
    polymerAddress,
    loggerOptions: loggerService.loggerOptions,
  };
}

export default (moduleInterface: CollectorModuleInterface) => {
  const { configService, loggerService } = moduleInterface;

  const globalPolymerConfig = loadGlobalPolymerConfig(configService);

  const workers: Record<string, Worker | null> = {};

  configService.chainsConfig.forEach((chainConfig) => {
    const workerData = loadWorkerData(
      configService,
      loggerService,
      chainConfig,
      globalPolymerConfig,
    );

    if (workerData) {
      const worker = new Worker(join(__dirname, 'polymer.service.js'), {
        workerData,
      });
      workers[workerData.chainId] = worker;

      worker.on('error', (error) =>
        loggerService.fatal(
          error,
          'Error on polymer collector service worker.',
        ),
      );

      worker.on('exit', (exitCode) => {
        workers[chainConfig.chainId] = null;
        loggerService.info(
          { exitCode, chainId: chainConfig.chainId },
          `Polymer collector service worker exited.`,
        );
      });
    }
  });

  // Initiate status log interval
  const logStatus = () => {
    const activeWorkers = [];
    const inactiveWorkers = [];
    for (const chainId of Object.keys(workers)) {
      if (workers[chainId] != null) activeWorkers.push(chainId);
      else inactiveWorkers.push(chainId);
    }
    const status = {
      activeWorkers,
      inactiveWorkers,
    };
    loggerService.info(status, 'Polymer collector workers status.');
  };
  setInterval(logStatus, STATUS_LOG_INTERVAL);
};
