import { join } from 'path';
import { Worker } from 'worker_threads';
import { CollectorModuleInterface } from '../collector.controller';
import { DEFAULT_GETTER_INTERVAL } from 'src/getter/getter.controller';
import { STATUS_LOG_INTERVAL } from 'src/logger/logger.service';

export default (moduleInterface: CollectorModuleInterface) => {
  const { configService, loggerService } = moduleInterface;

  const mockConfig = configService.ambsConfig.get('mock');

  if (mockConfig == undefined) {
    throw Error(`Failed to load Mock module: 'mock' configuration not found.`);
  }

  const defaultGetterInterval =
    configService.relayerConfig.getter['interval'] ?? DEFAULT_GETTER_INTERVAL;

  const workers: Record<string, Worker | null> = {};

  configService.chainsConfig.forEach(async (chainConfig) => {
    const chainId = chainConfig.chainId;

    const mockPrivateKey = mockConfig.globalProperties['privateKey'];
    if (mockPrivateKey == undefined) {
      throw Error(`Failed to load Mock module: 'privateKey' missing`);
    }

    const incentivesAddress = configService.getAMBConfig(
      'mock',
      'incentivesAddress',
      chainId,
    );

    const worker = new Worker(join(__dirname, 'mock.service.js'), {
      workerData: {
        chainConfig,
        incentivesAddress,
        mockPrivateKey,
        interval: chainConfig.getter['interval'] ?? defaultGetterInterval,
        maxBlocks: chainConfig.getter['maxBlocks'],
        blockDelay: chainConfig.blockDelay ?? 0,
        loggerOptions: loggerService.loggerOptions,
      },
    });
    workers[chainId] = worker;

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
