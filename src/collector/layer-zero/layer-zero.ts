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
  layerZeroChainIdMap: Record<number, string>;
  incentivesAddresses: Record<number, string>;
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
  incentivesAddresses: Record<number, string>;
  layerZeroChainIdMap: Record<number, string>;
}

// Function to load global configuration settings specific to Layer Zero.
function loadGlobalLayerZeroConfig(
  configService: ConfigService,
): GlobalLayerZeroConfig {
  const layerZeroConfig = configService.ambsConfig.get('layer-zero');

  const getterConfig = configService.globalConfig.getter;
  const retryInterval =
    getterConfig.retryInterval ?? DEFAULT_GETTER_RETRY_INTERVAL;
  const processingInterval =
    getterConfig.processingInterval ?? DEFAULT_GETTER_PROCESSING_INTERVAL;
  const maxBlocks = getterConfig.maxBlocks ?? DEFAULT_GETTER_MAX_BLOCKS;

  const layerZeroChainIdMap: Record<number, string> = {};
  const incentivesAddresses: Record<number, string> = {};

  // Load chainIdMap and incentivesAddresses directly from config
  for (const [chainId, chainConfig] of configService.chainsConfig) {
    const layerZeroChainId: number | undefined = configService.getAMBConfig<number>(
      'layer-zero',
      'layerZeroChainId',
      chainId.toString(),
    );
    const incentivesAddress: string | undefined = configService.getAMBConfig<string>(
      'layer-zero',
      'incentivesAddress',
      chainId.toString(),
    );

    if (layerZeroChainId !== undefined) {
      layerZeroChainIdMap[layerZeroChainId] = chainId;
    }
    if (layerZeroChainId !== undefined && incentivesAddress !== undefined) {
      incentivesAddresses[parseInt(chainId)] = incentivesAddress.toLowerCase();
    }
  }

  return {
    retryInterval,
    processingInterval,
    maxBlocks,
    layerZeroChainIdMap,
    incentivesAddresses,
  };
}


async function loadWorkerData(
  configService: ConfigService,
  monitorService: MonitorService,
  loggerService: LoggerService,
  chainConfig: ChainConfig,
  globalConfig: GlobalLayerZeroConfig,
): Promise<LayerZeroWorkerData | null> {
  const chainId = chainConfig.chainId;
  const rpc = chainConfig.rpc;
  try {
    const layerZeroChainId: number | undefined = configService.getAMBConfig<number>(
      'layer-zero',
      'layerZeroChainId',
      chainId.toString(),
    );
    const bridgeAddress: string | undefined = configService.getAMBConfig<string>(
      'layer-zero',
      'bridgeAddress',
      chainId.toString(),
    );
    const incentivesAddress: string | undefined = configService.getAMBConfig<string>(
      'layer-zero',
      'incentivesAddress',
      chainId.toString(),
    );
    const receiverAddress: string | undefined = configService.getAMBConfig(
      'layer-zero',
      'receiverAddress',
      chainId.toString(),
    );

    if (
      layerZeroChainId === undefined ||
      bridgeAddress === undefined ||
      incentivesAddress === undefined ||
      receiverAddress === undefined
    ) {
      return null;
    }
    const port = await monitorService.attachToMonitor(chainId);

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
      monitorPort: port,
      loggerOptions: loggerService.loggerOptions,
      incentivesAddresses: globalConfig.incentivesAddresses, 
      layerZeroChainIdMap: globalConfig.layerZeroChainIdMap, 
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

  const workersData: LayerZeroWorkerData[] = [];

  for (const [chainId, chainConfig] of configService.chainsConfig) {
    const workerData = await loadWorkerData(
      configService,
      monitorService,
      loggerService,
      chainConfig,
      globalLayerZeroConfig,
    );
    if (workerData !== null) {
      workersData.push(workerData);
    }
  }

  if (workersData.length === 0) {
    loggerService.warn(
      'Skipping Layer Zero worker initialization: no valid Layer Zero chain configs found',
    );
    return;
  }

  for (const workerData of workersData) {
    const worker = new Worker(join(__dirname, 'layer-zero.worker.js'), {
      workerData: workerData,
      transferList: [workerData.monitorPort],
    });
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
