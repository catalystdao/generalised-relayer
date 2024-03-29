import { join } from 'path';
import { Worker } from 'worker_threads';
import { CollectorModuleInterface } from '../collector.controller';
import { ConfigService } from 'src/config/config.service';
import { AMBConfig, ChainConfig } from 'src/config/config.types';
import { LoggerService, STATUS_LOG_INTERVAL } from 'src/logger/logger.service';
import {
  DEFAULT_GETTER_BLOCK_DELAY,
  DEFAULT_GETTER_INTERVAL,
  DEFAULT_GETTER_MAX_BLOCKS,
} from 'src/getter/getter.controller';
import { LoggerOptions } from 'pino';

export interface WormholeRelayerEngineWorkerData {
  isTestnet: boolean;
  useDocker: boolean;
  spyPort: string;
  wormholeChainConfig: Map<string, any>;
  reverseWormholeChainConfig: Map<string, any>;
  loggerOptions: LoggerOptions;
}

interface WormholeGlobalPacketSnifferConfig {
  blockDelay: number;
  interval: number;
  maxBlocks: number | null;
}

export interface WormholePacketSnifferWorkerData {
  chainId: string;
  rpc: string;
  startingBlock?: number;
  stoppingBlock?: number;
  blockDelay: number;
  interval: number;
  maxBlocks: number | null;
  incentivesAddress: string;
  wormholeAddress: string;
  loggerOptions: LoggerOptions;
}

function loadRelayerEngineWorkerData(
  wormholeConfig: AMBConfig,
  configService: ConfigService,
  loggerService: LoggerService,
): WormholeRelayerEngineWorkerData {
  // Get the chain-specific Wormhole config
  const wormholeChainConfig = new Map<string, any>();
  const reverseWormholeChainConfig = new Map<string, any>();
  configService.chainsConfig.forEach((chainConfig) => {
    const wormholeChainId: string | undefined = configService.getAMBConfig(
      'wormhole',
      'wormholeChainId',
      chainConfig.chainId,
    );

    if (wormholeChainId != undefined) {
      const incentivesAddress = wormholeConfig.getIncentivesAddress(
        chainConfig.chainId,
      );

      wormholeChainConfig.set(chainConfig.chainId, {
        wormholeChainId,
        incentivesAddress,
      });
      reverseWormholeChainConfig.set(
        String(wormholeChainId),
        chainConfig.chainId,
      );
      loggerService.info(
        `'wormholeChainId' for chain ${chainConfig.chainId} is set to ${wormholeChainId}.`,
      );
    } else {
      loggerService.info(
        `No 'wormholeChainId' set for chain ${chainConfig.chainId}. Skipping chain (wormhole collector).`,
      );
    }
  });

  return {
    isTestnet: wormholeConfig.globalProperties['isTestnet'],
    useDocker: process.env.USE_DOCKER == 'true',
    spyPort: process.env.SPY_PORT ?? '',
    wormholeChainConfig,
    reverseWormholeChainConfig,
    loggerOptions: loggerService.loggerOptions,
  };
}

function loadGlobalPacketSnifferConfig(
  configService: ConfigService,
): WormholeGlobalPacketSnifferConfig {
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

function loadPacketSnifferWorkerData(
  wormholeConfig: AMBConfig,
  configService: ConfigService,
  loggerService: LoggerService,
  chainConfig: ChainConfig,
  globalConfig: WormholeGlobalPacketSnifferConfig,
): WormholePacketSnifferWorkerData | undefined {
  const chainId = chainConfig.chainId;
  const rpc = chainConfig.rpc;

  const incentivesAddress = wormholeConfig.getIncentivesAddress(
    chainConfig.chainId,
  );

  const wormholeAddress = configService.getAMBConfig(
    'wormhole',
    'bridgeAddress',
    chainConfig.chainId,
  ) as string | undefined;

  if (wormholeAddress == undefined) return undefined;

  return {
    chainId,
    rpc,
    startingBlock: chainConfig.startingBlock,
    stoppingBlock: chainConfig.stoppingBlock,
    blockDelay: chainConfig.blockDelay ?? globalConfig.blockDelay,
    interval: chainConfig.getter.interval ?? globalConfig.interval,
    maxBlocks: chainConfig.getter.maxBlocks ?? globalConfig.maxBlocks,
    incentivesAddress,
    wormholeAddress,
    loggerOptions: loggerService.loggerOptions,
  };
}

function initiateRelayerEngineWorker(
  wormholeConfig: AMBConfig,
  configService: ConfigService,
  loggerService: LoggerService,
): void {
  loggerService.info('Starting the wormhole relayer engine...');

  const workerData = loadRelayerEngineWorkerData(
    wormholeConfig,
    configService,
    loggerService,
  );

  const worker = new Worker(join(__dirname, 'wormhole-engine.service.js'), {
    workerData,
  });
  let workerRunning = true;

  worker.on('error', (error) =>
    loggerService.fatal(error, 'Error on Wormhole engine worker.'),
  );

  worker.on('exit', (exitCode) => {
    workerRunning = false;
    loggerService.info({ exitCode }, `Wormhole engine worker exited.`);
  });

  // Initiate status log interval
  const logStatus = () => {
    loggerService.info(
      { isRunning: workerRunning },
      `Wormhole collector relayer engine workers status.`,
    );
  };
  setInterval(logStatus, STATUS_LOG_INTERVAL);
}

function initiatePacketSnifferWorkers(
  wormholeConfig: AMBConfig,
  configService: ConfigService,
  loggerService: LoggerService,
): void {
  loggerService.info('Starting the wormhole packet sniffer workers...');

  const workers: Record<string, Worker | null> = {};

  const globalMockConfig = loadGlobalPacketSnifferConfig(configService);

  configService.chainsConfig.forEach((chainConfig) => {
    // Spawn a worker for every Wormhole implementation
    const workerData = loadPacketSnifferWorkerData(
      wormholeConfig,
      configService,
      loggerService,
      chainConfig,
      globalMockConfig,
    );

    if (workerData) {
      const worker = new Worker(join(__dirname, 'wormhole.service.js'), {
        workerData,
      });
      workers[chainConfig.chainId] = worker;

      worker.on('error', (error) =>
        loggerService.fatal(
          { error, chainId: chainConfig.chainId },
          'Error on Wormhole service worker.',
        ),
      );

      worker.on('exit', (exitCode) => {
        workers[chainConfig.chainId] = null;
        loggerService.info(
          { exitCode, chainId: chainConfig.chainId },
          `Wormhole service worker exited.`,
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
    loggerService.info(
      status,
      'Wormhole collector packet sniffer workers status.',
    );
  };
  setInterval(logStatus, STATUS_LOG_INTERVAL);
}

export default (moduleInterface: CollectorModuleInterface) => {
  const { configService, loggerService } = moduleInterface;

  // Get the global Wormhole config
  const wormholeConfig = configService.ambsConfig.get('wormhole');
  if (wormholeConfig == undefined) {
    throw Error(
      `Failed to load Wormhole module: 'wormhole' configuration not found.`,
    );
  }

  initiateRelayerEngineWorker(wormholeConfig, configService, loggerService);

  initiatePacketSnifferWorkers(wormholeConfig, configService, loggerService);
};
