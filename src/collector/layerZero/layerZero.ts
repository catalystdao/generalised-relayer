import { join } from 'path';
import { Worker, MessagePort } from 'worker_threads';
import { CollectorModuleInterface } from '../collector.controller';
import {
  DEFAULT_GETTER_RETRY_INTERVAL,
  DEFAULT_GETTER_PROCESSING_INTERVAL,
  DEFAULT_GETTER_MAX_BLOCKS,
} from '../../getter/getter.service';
import {
  LoggerService,
  STATUS_LOG_INTERVAL,
} from '../../logger/logger.service';
import { ConfigService } from '../../config/config.service';
import { ChainConfig } from '../../config/config.types';
import { LoggerOptions } from 'pino';
import { MonitorService } from '../../monitor/monitor.service';

interface GlobalLayerZeroConfig {
  retryInterval: number;
  processingInterval: number;
  maxBlocks: number | null;
}

export interface LayerZeroWorkerData {
  chainId: string;
  rpc: string;
  resolver: string | null;
  startingBlock?: number;
  stoppingBlock?: number;
  retryInterval: number;
  processingInterval: number;
  maxBlocks: number | null;
  layerZeroChainId: number;
  bridgeAddress: string;
  incentivesAddress: string;
  receiverAddress: string;
  monitorPort: MessagePort;
  loggerOptions: LoggerOptions;
}

// Function to load global configuration settings specific to Layer Zero.
function loadGlobalLayerZeroConfig(
  configService: ConfigService,
): GlobalLayerZeroConfig {
  const layerZeroConfig = configService.ambsConfig.get('layerZero');
  if (layerZeroConfig == undefined) {
    throw Error(
      `Failed to load Layer Zero module: 'layerZero' configuration not found.`,
    );
  }

  const getterConfig = configService.globalConfig.getter;
  const retryInterval =
    getterConfig.retryInterval ?? DEFAULT_GETTER_RETRY_INTERVAL;
  const processingInterval =
    getterConfig.processingInterval ?? DEFAULT_GETTER_PROCESSING_INTERVAL;
  const maxBlocks =
    getterConfig.maxBlocks ?? DEFAULT_GETTER_MAX_BLOCKS;

  return {
    retryInterval,
    processingInterval,
    maxBlocks,
  };
}

function loadLayerZeroChainIdMap(
  workerDataArray: LayerZeroWorkerData[],
): Record<number, string> {
  const layerZeroChainIdMap: Record<number, string> = {};
  for (const workerData of workerDataArray) {
    layerZeroChainIdMap[workerData.layerZeroChainId] = workerData.chainId;
  }
  return layerZeroChainIdMap;
}

async function loadWorkerData(
  configService: ConfigService,
  monitorService: MonitorService,
  loggerService: LoggerService,
  chainConfig: ChainConfig,
  globalConfig: GlobalLayerZeroConfig,
): Promise<LayerZeroWorkerData> {
  const chainId = chainConfig.chainId;
  const rpc = chainConfig.rpc;
  try {
    const layerZeroChainId: number | undefined =
      configService.getAMBConfig<number>(
        'layerZero',
        'layerZeroChainId',
        chainId.toString(),
      );
    const bridgeAddress: string | undefined =
      configService.getAMBConfig<string>(
        'layerZero',
        'bridgeAddress',
        chainId.toString(),
      );
    const incentivesAddress: string | undefined =
      configService.getAMBConfig<string>(
        'layerZero',
        'incentivesAddress',
        chainId.toString(),
      );
    const receiverAddress: string | undefined = configService.getAMBConfig(
      'layerZero',
      'receiverAddress',
      chainId.toString(),
    );
    if (layerZeroChainId == undefined) {
      throw Error(
        `Failed to load Layer Zero module: 'layerZeroChainId' missing`,
      );
    }
    if (bridgeAddress == undefined) {
      throw Error(`Failed to load Layer Zero module: 'bridgeAddress' missing`);
    }
    if (incentivesAddress == undefined) {
      throw Error(
        `Failed to load Layer Zero module: 'incentivesAddress' missing`,
      );
    }
    if (receiverAddress == undefined) {
      throw Error(`Failed to load Layer Zero module: 'receiverAddress' missing`);
    }

    const port1 = await monitorService.attachToMonitor(chainId);

    return {
      chainId,
      rpc,
      resolver: chainConfig.resolver,
      startingBlock: chainConfig.startingBlock,
      stoppingBlock: chainConfig.stoppingBlock,
      retryInterval:
        chainConfig.getter.retryInterval ?? globalConfig.retryInterval,
      processingInterval:
        chainConfig.getter.processingInterval ??
        globalConfig.processingInterval,
      maxBlocks: chainConfig.getter.maxBlocks ?? globalConfig.maxBlocks,
      layerZeroChainId,
      bridgeAddress,
      incentivesAddress,
      receiverAddress,
      monitorPort: port1,
      loggerOptions: loggerService.loggerOptions,
    };
  } catch (error) {
    loggerService.error(
      error,
      'Failed to load Layer Zero module: missing configuration.',
    );
    throw error;
  }
}

// Main function for initializing Layer Zero worker.
export default async (moduleInterface: CollectorModuleInterface) => {
  const { configService, monitorService, loggerService } = moduleInterface;

  const globalLayerZeroConfig = loadGlobalLayerZeroConfig(configService);

  const workers: Record<string, Worker | null> = {};

  const workerDataArray: LayerZeroWorkerData[] = [];
  for (const [chainId, chainConfig] of configService.chainsConfig) {
    const workerData = await loadWorkerData(
      configService,
      monitorService,
      loggerService,
      chainConfig,
      globalLayerZeroConfig,
    );
    workerDataArray.push(workerData);
  }
  
  if (workerDataArray.length === 0) {
    loggerService.warn(
      'Skipping Layer Zero worker initialization: no Layer Zero chain configs found',
    );
    return;
  }

  const layerZeroChainIdMap = loadLayerZeroChainIdMap(workerDataArray);
  loggerService.info({ layerZeroChainIdMap }, 'Layer Zero Chain ID Map loaded.');

  for (const workerData of workerDataArray) {
    // Attach the mapping to each worker data
    const workerDataWithMapping = { ...workerData, layerZeroChainIdMap };
    const worker = new Worker(
      join(__dirname, 'layerZero.worker.js'),
      {
        workerData: workerDataWithMapping,
        transferList: [workerData.monitorPort],
      },
    );
    workers[workerData.chainId] = worker;

    worker.on('error', (error) =>
      loggerService.fatal(error, 'Error on Layer Zero Worker.'),
    );
    worker.on('exit', (exitCode) => {
      workers[workerData.chainId] = null;
      loggerService.info(
        { exitCode, chainId: workerData.chainId },
        `Layer Zero Worker exited.`,
      );
    });
  }

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
    loggerService.info(status, 'Layer Zero collector workers status.');
  };

  setInterval(logStatus, STATUS_LOG_INTERVAL);
};
