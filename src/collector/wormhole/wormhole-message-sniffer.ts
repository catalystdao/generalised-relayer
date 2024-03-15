import { join } from 'path';
import { Worker } from 'worker_threads';
import { LoggerService, STATUS_LOG_INTERVAL } from 'src/logger/logger.service';
import {
  WormholeConfig,
  WormholeMessageSnifferWorkerData,
} from './wormhole.types';

function loadMessageSnifferWorkerData(
  chainId: string,
  wormholeConfig: WormholeConfig,
): WormholeMessageSnifferWorkerData | null {
  const wormholeChainConfig = wormholeConfig.wormholeChainConfigs.get(chainId);
  if (wormholeChainConfig == undefined) {
    return null;
  }

  return {
    ...wormholeChainConfig,
    wormholeChainIdMap: wormholeConfig.wormholeChainIdMap,
    loggerOptions: wormholeConfig.loggerOptions,
  };
}

export function initiateMessageSnifferWorkers(
  wormholeConfig: WormholeConfig,
  loggerService: LoggerService,
): void {
  loggerService.info('Starting the wormhole message sniffer workers...');

  const workers: Record<string, Worker | null> = {};

  for (const [chainId] of wormholeConfig.wormholeChainConfigs) {
    // Spawn a worker for every Wormhole implementation
    const workerData = loadMessageSnifferWorkerData(chainId, wormholeConfig);

    if (workerData) {
      const worker = new Worker(
        join(__dirname, 'wormhole-message-sniffer.worker.js'),
        {
          workerData,
        },
      );
      workers[chainId] = worker;

      worker.on('error', (error) =>
        loggerService.fatal(
          { error, chainId: chainId },
          'Error on Wormhole service worker.',
        ),
      );

      worker.on('exit', (exitCode) => {
        workers[chainId] = null;
        loggerService.info(
          { exitCode, chainId: chainId },
          `Wormhole service worker exited.`,
        );
      });
    }
  }

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
      'Wormhole collector message sniffer workers status.',
    );
  };
  setInterval(logStatus, STATUS_LOG_INTERVAL);
}
