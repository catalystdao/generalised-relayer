import { join } from 'path';
import { Worker } from 'worker_threads';
import { CollectorModuleInterface } from '../collector.controller';
import { ConfigService } from 'src/config/config.service';
import { LoggerService, STATUS_LOG_INTERVAL } from 'src/logger/logger.service';
import { DEFAULT_GETTER_INTERVAL } from 'src/getter/getter.controller';
import { Store } from 'src/store/store.lib';
import { AmbMessage } from 'src/store/types/store.types';

function initiateRelayerEngineWorker(
  configService: ConfigService,
  loggerService: LoggerService,
): void {
  loggerService.info('Starting the wormhole relayer engine...');

  // Get the global Wormhole config
  const wormholeConfig = configService.ambsConfig.get('wormhole');
  if (wormholeConfig == undefined) {
    throw Error(
      `Failed to load Wormhole module: 'wormhole' configuration not found.`,
    );
  }

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
      loggerService.warn(
        `'wormholeChainId' for chain ${chainConfig.chainId} is set to ${wormholeChainId}.`,
      );
    } else {
      loggerService.warn(
        `No 'wormholeChainId' set for chain ${chainConfig.chainId}. Skipping chain (wormhole collector).`,
      );
    }
  });

  const worker = new Worker(join(__dirname, 'wormhole-engine.service.js'), {
    workerData: {
      isTestnet: wormholeConfig.globalProperties['isTestnet'],
      useDocker: process.env.USE_DOCKER ?? false,
      spyPort: process.env.SPY_PORT,
      wormholeChainConfig,
      reverseWormholeChainConfig,
      loggerOptions: loggerService.loggerOptions,
    },
  });
  let workerRunning = true;

  worker.on('error', (error) =>
    loggerService.fatal(error, 'Error on Wormhole engine worker.'),
  );

  worker.on('exit', (exitCode) => {
    workerRunning = false;
    loggerService.info(`Wormhole engine worker exited with code ${exitCode}.`);
  });

  // Initiate status log interval
  const logStatus = () => {
    loggerService.info(
      `Wormhole collector relayer engine workers status: ${
        workerRunning ? 'running' : 'stopped'
      }`,
    );
  };
  setInterval(logStatus, STATUS_LOG_INTERVAL);
}

function initiatePacketSnifferWorkers(
  configService: ConfigService,
  loggerService: LoggerService,
): void {
  loggerService.info('Starting the wormhole packet sniffer workers...');
  const store = new Store();

  const workers: Record<string, Worker | null> = {};

  // Get the global Wormhole config
  const wormholeConfig = configService.ambsConfig.get('wormhole');
  if (wormholeConfig == undefined) {
    throw Error(
      `Failed to load Wormhole module: 'wormhole' configuration not found.`,
    );
  }

  // Set the default wormhole packet sniffer worker interval to equal that of the getter workers.
  const defaultWorkerInterval =
    configService.relayerConfig.getter['interval'] ?? DEFAULT_GETTER_INTERVAL;

  const defaultMaxBlocks =
    configService.relayerConfig.getter['maxBlocks'] ?? undefined;

  configService.chainsConfig.forEach((chainConfig) => {
    // Spawn a worker for every Wormhole implementation

    const incentivesAddress = wormholeConfig.getIncentivesAddress(
      chainConfig.chainId,
    );

    const wormholeAddress = configService.getAMBConfig(
      'wormhole',
      'bridgeAddress',
      chainConfig.chainId,
    );

    if (wormholeAddress) {
      const worker = new Worker(join(__dirname, 'wormhole.service.js'), {
        workerData: {
          incentivesAddress,
          wormholeAddress,
          chainConfig,
          interval: chainConfig.getter['interval'] ?? defaultWorkerInterval,
          maxBlocks: chainConfig.getter['maxBlocks'] ?? defaultMaxBlocks,
          loggerOptions: loggerService.loggerOptions,
        },
      });
      workers[chainConfig.chainId] = worker;

      worker.on('message', (amb: AmbMessage) => {
        store.setAmb(amb);
      });

      worker.on('error', (error) =>
        loggerService.fatal(error, 'Error on Wormhole service worker.'),
      );

      worker.on('exit', (exitCode) => {
        workers[chainConfig.chainId] = null;
        loggerService.info(
          `Wormhole service worker exited with code ${exitCode}.`,
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

  initiateRelayerEngineWorker(configService, loggerService);

  initiatePacketSnifferWorkers(configService, loggerService);
};
