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
    // Retrieve Layer Zero configuration from the configuration service.
    const layerZeroConfig = configService.ambsConfig.get('layerZero');
    console.log(layerZeroConfig);
    // Throw an error if Layer Zero configuration is missing.
    if (layerZeroConfig == undefined) {
        throw Error(
            `Failed to load Layer Zero module: 'layerZero' configuration not found.`,
        );
    }

    // Retrieve global getter configuration settings.
    const getterConfig = configService.globalConfig.getter;
    // Set default values for retry interval, processing interval, and max blocks if not provided in the configuration.
    const retryInterval =
    getterConfig.retryInterval ?? DEFAULT_GETTER_RETRY_INTERVAL;
    const processingInterval =
    getterConfig.processingInterval ?? DEFAULT_GETTER_PROCESSING_INTERVAL;
    const maxBlocks = getterConfig.maxBlocks ?? DEFAULT_GETTER_MAX_BLOCKS;


    // Return global Layer Zero configuration settings.
    return {
        retryInterval,
        processingInterval,
        maxBlocks,
    };
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
            throw Error(
                `Failed to load Layer Zero module: 'bridgeAddress' missing`,
            );
        }
        if (incentivesAddress == undefined) {
            throw Error(
                `Failed to load Layer Zero module: 'incentivesAddress' missing`,
            );
        }
        if (receiverAddress == undefined) {
            throw Error(`Failed to load Layer Zero module: 'bridgeAddress' missing`);
        }

        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        const port1= await monitorService.attachToMonitor(chainId);
        console.log(`Monitor attached to chainId: ${chainId}`);

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

// Main function for initializing Layer Zero workers.
export default async (moduleInterface: CollectorModuleInterface) => {
    const { configService, monitorService, loggerService } = moduleInterface;

    const globalLayerZeroConfig = loadGlobalLayerZeroConfig(configService);

    const GARPWorkers: Record<string, Worker | null> = {};
    const ULNBaseWorkers: Record<string, Worker | null> = {};


    for (const [chainId, chainConfig] of configService.chainsConfig) {
        const GARPWorkerData = await loadWorkerData(
            configService,
            monitorService,
            loggerService,
            chainConfig,
            globalLayerZeroConfig,
        );

        const ULNBaseWorkerData = await loadWorkerData(
            configService,
            monitorService,
            loggerService,
            chainConfig,
            globalLayerZeroConfig,
        );

        const GARPWorker = new Worker(join(__dirname, 'layerZero-message-sniffer-worker.js'), {
            workerData: GARPWorkerData,
            transferList: [GARPWorkerData.monitorPort],
        });
        GARPWorkers[GARPWorkerData.chainId] = GARPWorker;

        GARPWorker.on('error', (error) =>
            loggerService.fatal(error, 'Error on Layer Zero Message Sniffer Worker.'),
        );
        GARPWorker.on('exit', (exitCode) => {
            GARPWorkers[chainId] = null;
            loggerService.info({ exitCode, chainId }, `Layer Zero Message Sniffer Worker exited.`);
        });

        const ULNBaseWorker = new Worker(join(__dirname, 'layerZero-proofs-worker.js'), {
            workerData: ULNBaseWorkerData,
            transferList: [ULNBaseWorkerData.monitorPort],
        });
        ULNBaseWorkers[ULNBaseWorkerData.chainId] = ULNBaseWorker;

        ULNBaseWorker.on('error', (error) =>
            loggerService.fatal(error, 'Error on Layer Zero Proofs Collector Worker'),
        );
        ULNBaseWorker.on('exit', (exitCode) => {
            ULNBaseWorkers[chainId] = null;
            loggerService.info({ exitCode, chainId }, `Layer Zero Proofs Collector Worker exited.`);
        });
    }

    const logStatus = () => {
        const activeGARPWorkers = [];
        const inactiveGARPWorkers = [];
        const activeULNBaseWorkers = [];
        const inactiveULNBaseWorkers = [];

        for (const chainId of Object.keys(GARPWorkers)) {
            if (GARPWorkers[chainId] != null) activeGARPWorkers.push(chainId);
            else inactiveGARPWorkers.push(chainId);
        }

        for (const chainId of Object.keys(ULNBaseWorkers)) {
            if (ULNBaseWorkers[chainId] != null) activeULNBaseWorkers.push(chainId);
            else inactiveULNBaseWorkers.push(chainId);
        }

        const status = {
            activeGARPWorkers,
            inactiveGARPWorkers: inactiveGARPWorkers,
            activeULNBaseWorkers,
            inactiveULNBaseWorkers,
        };
        loggerService.info(status, 'Layer Zero collector workers status.');
    };

    setInterval(logStatus, STATUS_LOG_INTERVAL);
};
