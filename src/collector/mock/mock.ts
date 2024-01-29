import { join } from 'path';
import { Worker } from 'worker_threads';
import { CollectorModuleInterface } from '../collector.controller';
import {
  DEFAULT_GETTER_BLOCK_DELAY,
  DEFAULT_GETTER_INTERVAL,
  DEFAULT_GETTER_MAX_BLOCKS,
} from 'src/getter/getter.controller';
import { LoggerService, STATUS_LOG_INTERVAL } from 'src/logger/logger.service';
import { ChainConfig, ConfigService } from 'src/config/config.service';
import { LoggerOptions } from 'pino';

interface GlobalMockConfig {
  blockDelay: number;
  interval: number;
  maxBlocks: number | null;
  privateKey: string;
}

export interface MockWorkerData {
  chainId: string;
  rpc: string;
  startingBlock?: number;
  stoppingBlock?: number;
  blockDelay: number;
  interval: number;
  maxBlocks: number | null;
  incentivesAddress: string;
  privateKey: string;
  loggerOptions: LoggerOptions;
}

function loadGlobalMockConfig(configService: ConfigService): GlobalMockConfig {
  const mockConfig = configService.ambsConfig.get('mock');
  if (mockConfig == undefined) {
    throw Error(`Failed to load Mock module: 'mock' configuration not found.`);
  }

  const blockDelay =
    configService.relayerConfig.blockDelay ?? DEFAULT_GETTER_BLOCK_DELAY;

  const getterConfig = configService.relayerConfig.getter;
  const interval = getterConfig.interval ?? DEFAULT_GETTER_INTERVAL;
  const maxBlocks = getterConfig.maxBlocks ?? DEFAULT_GETTER_MAX_BLOCKS;

  const privateKey = mockConfig.globalProperties['privateKey'];
  if (privateKey == undefined) {
    throw Error(`Failed to load Mock module: 'privateKey' missing`);
  }

  return {
    blockDelay,
    interval,
    maxBlocks,
    privateKey,
  };
}

function loadWorkerData(
  configService: ConfigService,
  loggerService: LoggerService,
  chainConfig: ChainConfig,
  globalConfig: GlobalMockConfig,
): MockWorkerData {
  const chainId = chainConfig.chainId;
  const rpc = chainConfig.rpc;

  const incentivesAddress = configService.getAMBConfig(
    'mock',
    'incentivesAddress',
    chainId,
  ) as string;

  return {
    chainId,
    rpc,
    startingBlock: chainConfig.startingBlock,
    stoppingBlock: chainConfig.stoppingBlock,
    blockDelay: chainConfig.blockDelay ?? globalConfig.blockDelay,
    interval: chainConfig.getter.interval ?? globalConfig.interval,
    maxBlocks: chainConfig.getter.maxBlocks ?? globalConfig.maxBlocks,
    incentivesAddress,
    privateKey: globalConfig.privateKey,
    loggerOptions: loggerService.loggerOptions,
  };
}

export default (moduleInterface: CollectorModuleInterface) => {
  const { configService, loggerService } = moduleInterface;

  const globalMockConfig = loadGlobalMockConfig(configService);

  const workers: Record<string, Worker | null> = {};

  configService.chainsConfig.forEach((chainConfig) => {
    const workerData = loadWorkerData(
      configService,
      loggerService,
      chainConfig,
      globalMockConfig,
    );

    const worker = new Worker(join(__dirname, 'mock.service.js'), {
      workerData,
    });
    workers[workerData.chainId] = worker;

    worker.on('error', (error) =>
      loggerService.fatal(error, 'Error on mock collector service worker.'),
    );

    worker.on('exit', (exitCode) => {
      workers[chainConfig.chainId] = null;
      loggerService.info(
        `Mock collector service worker exited with code ${exitCode}.`,
      );
    });
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
    loggerService.info(status, 'Mock collector workers status.');
  };
  setInterval(logStatus, STATUS_LOG_INTERVAL);
};
