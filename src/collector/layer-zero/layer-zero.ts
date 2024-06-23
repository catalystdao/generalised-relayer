/**
 * This file initializes and manages Layer Zero workers.
 * 
 * Inputs:
 * - ConfigService: Service to fetch configuration settings.
 * - MonitorService: Service to monitor and manage workers.
 * - LoggerService: Service to log information and errors.
 * - ChainConfig: Configuration settings for different chains.
 * - CollectorModuleInterface: Interface for the collector module.
 * 
 * Outputs:
 * - Initializes and manages Layer Zero worker threads.
 * - Logs status and errors related to the worker threads.
 */

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

/**
 * Loads global configuration settings specific to Layer Zero.
 * 
 * @param configService - Service to fetch configuration settings.
 * @returns Global configuration settings for Layer Zero.
 */
function loadGlobalLayerZeroConfig(configService: ConfigService): GlobalLayerZeroConfig { 
  const layerZeroConfig = configService.ambsConfig.get('layer-zero');

  const getterConfig = configService.globalConfig.getter;
  const retryInterval = getterConfig.retryInterval ?? DEFAULT_GETTER_RETRY_INTERVAL;
  const processingInterval = getterConfig.processingInterval ?? DEFAULT_GETTER_PROCESSING_INTERVAL;
  const maxBlocks = getterConfig.maxBlocks ?? DEFAULT_GETTER_MAX_BLOCKS;

  const layerZeroChainIdMap: Record<number, string> = {};
  const incentivesAddresses: Record<number, string> = {};

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

/**
 * Loads worker data for a specific chain configuration.
 * 
 * @param configService - Service to fetch configuration settings.
 * @param monitorService - Service to monitor and manage workers.
 * @param loggerService - Service to log information and errors.
 * @param chainConfig - Configuration settings for a specific chain.
 * @param globalConfig - Global configuration settings for Layer Zero.
 * @returns Worker data for the specific chain or null if configuration is incomplete.
 */
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
    const layerZeroChainId = configService.getAMBConfig<number>('layer-zero', 'layerZeroChainId', chainId.toString());
    const bridgeAddress = configService.getAMBConfig<string>('layer-zero', 'bridgeAddress', chainId.toString());
    const incentivesAddress = configService.getAMBConfig<string>('layer-zero', 'incentivesAddress', chainId.toString());
    const receiverAddress = configService.getAMBConfig<string>('layer-zero', 'receiverAddress', chainId.toString());

    if (!layerZeroChainId || !bridgeAddress || !incentivesAddress || !receiverAddress) {
      return null;
    }

    const port = await monitorService.attachToMonitor(chainId);

    return {
      chainId,
      rpc,
      resolver: chainConfig.resolver,
      startingBlock: chainConfig.startingBlock,
      stoppingBlock: chainConfig.stoppingBlock,
      retryInterval: chainConfig.getter.retryInterval ?? globalConfig.retryInterval,
      processingInterval: chainConfig.getter.processingInterval ?? globalConfig.processingInterval,
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
    loggerService.error(error, 'Failed to load Layer Zero module: missing configuration.');
    throw error;
  }
}

/**
 * Main function for initializing Layer Zero workers.
 * 
 * @param moduleInterface - Interface for the collector module.
 */
export default async (moduleInterface: CollectorModuleInterface) => {
  const { configService, monitorService, loggerService } = moduleInterface;
  const globalLayerZeroConfig = loadGlobalLayerZeroConfig(configService);

  const workers: Record<string, Worker | null> = {};
  const workersData: LayerZeroWorkerData[] = [];

  for (const [chainId, chainConfig] of configService.chainsConfig) {
    const workerData = await loadWorkerData(configService, monitorService, loggerService, chainConfig, globalLayerZeroConfig);
    if (workerData) {
      workersData.push(workerData);
    }
  }

  if (workersData.length === 0) {
    loggerService.warn('Skipping Layer Zero worker initialization: no valid Layer Zero chain configs found');
    return;
  }

  initializeWorkers(workersData, workers, loggerService); 

  setInterval(() => logStatus(workers, loggerService), STATUS_LOG_INTERVAL); 
};

/**
 * Initializes workers with the given data and logs errors and exit statuses.
 * 
 * @param workersData - Array of worker data to initialize.
 * @param workers - Record to keep track of active workers.
 * @param loggerService - Service to log information and errors.
 */
function initializeWorkers(
  workersData: LayerZeroWorkerData[],
  workers: Record<string, Worker | null>,
  loggerService: LoggerService,
) { 
  for (const workerData of workersData) {
    const worker = new Worker(join(__dirname, 'layer-zero.worker.js'), {
      workerData: workerData,
      transferList: [workerData.monitorPort],
    });
    workers[workerData.chainId] = worker;

    worker.on('error', (error) => loggerService.fatal(error, 'Error on Layer Zero Worker.'));
    worker.on('exit', (exitCode) => {
      workers[workerData.chainId] = null;
      loggerService.info({ exitCode, chainId: workerData.chainId }, `Layer Zero Worker exited.`);
    });
  }
}

/**
 * Logs the status of active and inactive workers.
 * 
 * @param workers - Record of active and inactive workers.
 * @param loggerService - Service to log information.
 */
function logStatus(workers: Record<string, Worker | null>, loggerService: LoggerService) { 
  const activeWorkers = [];
  const inactiveWorkers = [];

  for (const chainId of Object.keys(workers)) {
    if (workers[chainId]) {
      activeWorkers.push(chainId);
    } else {
      inactiveWorkers.push(chainId);
    }
  }

  const status = {
    activeWorkers,
    inactiveWorkers,
  };
  loggerService.info(status, 'Layer Zero collector workers status.');
}
