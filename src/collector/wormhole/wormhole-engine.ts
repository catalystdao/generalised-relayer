import { join } from 'path';
import { Worker } from 'worker_threads';
import { LoggerService, STATUS_LOG_INTERVAL } from 'src/logger/logger.service';
import { WormholeConfig } from './wormhole.types';

export function initiateRelayerEngineWorker(
  wormholeConfig: WormholeConfig,
  loggerService: LoggerService,
): void {
  loggerService.info('Starting the wormhole relayer engine...');

  const workerData = wormholeConfig;
  if (workerData.wormholeChainConfigs.size == 0) {
    loggerService.warn(
      'Skipping relayer engine worker initialization: no Wormhole chain configs found',
    );
    return;
  }

  const worker = new Worker(join(__dirname, 'wormhole-engine.worker.js'), {
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
