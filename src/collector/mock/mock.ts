import { join } from 'path';
import { Worker, MessagePort } from 'worker_threads';
import { CollectorModuleInterface } from '../collector.controller';
import {
  DEFAULT_GETTER_RETRY_INTERVAL,
  DEFAULT_GETTER_PROCESSING_INTERVAL,
  DEFAULT_GETTER_MAX_BLOCKS,
} from 'src/getter/getter.service';
import { LoggerService, STATUS_LOG_INTERVAL } from 'src/logger/logger.service';
import { ConfigService } from 'src/config/config.service';
import { ChainConfig } from 'src/config/config.types';
import { LoggerOptions } from 'pino';
import { MonitorService } from 'src/monitor/monitor.service';

interface GlobalMockConfig {
  retryInterval: number;
  processingInterval: number;
  maxBlocks: number | null;
  privateKey: string;
}

export interface MockWorkerData {
  chainId: string;
  rpc: string;
  startingBlock?: number;
  stoppingBlock?: number;
  retryInterval: number;
  processingInterval: number;
  maxBlocks: number | null;
  incentivesAddress: string;
  privateKey: string;
  monitorPort: MessagePort;
  loggerOptions: LoggerOptions;
}

function loadGlobalMockConfig(configService: ConfigService): GlobalMockConfig {
  const mockConfig = configService.ambsConfig.get('mock');
  if (mockConfig == undefined) {
    throw Error(`Failed to load Mock module: 'mock' configuration not found.`);
  }

  const getterConfig = configService.globalConfig.getter;
  const retryInterval = getterConfig.retryInterval ?? DEFAULT_GETTER_RETRY_INTERVAL;
  const processingInterval = getterConfig.processingInterval ?? DEFAULT_GETTER_PROCESSING_INTERVAL;
  const maxBlocks = getterConfig.maxBlocks ?? DEFAULT_GETTER_MAX_BLOCKS;

  const privateKey = mockConfig.globalProperties['privateKey'];
  if (privateKey == undefined) {
    throw Error(`Failed to load Mock module: 'privateKey' missing`);
  }

  return {
    retryInterval,
    processingInterval,
    maxBlocks,
    privateKey,
  };
}

async function loadWorkerData(
  configService: ConfigService,
  monitorService: MonitorService,
  loggerService: LoggerService,
  chainConfig: ChainConfig,
  globalConfig: GlobalMockConfig,
): Promise<MockWorkerData> {
  const chainId = chainConfig.chainId;
  const rpc = chainConfig.rpc;

  //TODO implement if 'undefined' (see Wormhole/Polymer implementations)
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
    retryInterval: chainConfig.getter.retryInterval ?? globalConfig.retryInterval,
    processingInterval: chainConfig.getter.processingInterval ?? globalConfig.processingInterval,
    maxBlocks: chainConfig.getter.maxBlocks ?? globalConfig.maxBlocks,
    incentivesAddress,
    privateKey: globalConfig.privateKey,
    monitorPort: await monitorService.attachToMonitor(chainId),
    loggerOptions: loggerService.loggerOptions,
  };
}

export default async (moduleInterface: CollectorModuleInterface) => {
  const { configService, monitorService, loggerService } = moduleInterface;

  const globalMockConfig = loadGlobalMockConfig(configService);

  const workers: Record<string, Worker | null> = {};

  for (const [chainId, chainConfig] of configService.chainsConfig) {
    const workerData = await loadWorkerData(
      configService,
      monitorService,
      loggerService,
      chainConfig,
      globalMockConfig,
    );

    const worker = new Worker(join(__dirname, 'mock.worker.js'), {
      workerData,
      transferList: [workerData.monitorPort]
    });
    workers[workerData.chainId] = worker;

    worker.on('error', (error) =>
      loggerService.fatal(error, 'Error on mock collector service worker.'),
    );

    worker.on('exit', (exitCode) => {
      workers[chainId] = null;
      loggerService.info(
        { exitCode, chainId },
        `Mock collector service worker exited.`,
      );
    });
  };

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
