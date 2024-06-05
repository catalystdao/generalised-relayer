import { join } from 'path';
import { Worker, MessageChannel, MessagePort } from 'worker_threads';
import { CollectorModuleInterface } from '../collector.controller';
import {
    DEFAULT_GETTER_RETRY_INTERVAL,
    DEFAULT_GETTER_PROCESSING_INTERVAL,
    DEFAULT_GETTER_MAX_BLOCKS,
} from '../../getter/getter.service';
import { LoggerService, STATUS_LOG_INTERVAL } from '../../logger/logger.service';
import { ConfigService } from '../../config/config.service';
import { ChainConfig } from '../../config/config.types';
import { LoggerOptions } from 'pino';
import { MonitorService } from '../../monitor/monitor.service';

interface GlobalLayerZeroConfig {
    retryInterval: number;
    processingInterval: number;
    maxBlocks: number | null;
    privateKey: string;
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
    incentivesAddress: string;
    bridgeAddress: string| undefined;
    privateKey: string;
    monitorPort: MessagePort;
    loggerOptions: LoggerOptions;
}

// Function to load global configuration settings specific to Layer Zero.
function loadGlobalLayerZeroConfig(configService: ConfigService): GlobalLayerZeroConfig {
    // Retrieve Layer Zero configuration from the configuration service.
    const layerZeroConfig = configService.ambsConfig.get('layerZero');
    console.log(layerZeroConfig)
    // Throw an error if Layer Zero configuration is missing.
    if (layerZeroConfig == undefined) {
        throw Error(`Failed to load Layer Zero module: 'layerZero' configuration not found.`);
    }

    // Retrieve global getter configuration settings.
    const getterConfig = configService.globalConfig.getter;
    // Set default values for retry interval, processing interval, and max blocks if not provided in the configuration.
    const retryInterval = getterConfig.retryInterval ?? DEFAULT_GETTER_RETRY_INTERVAL;
    const processingInterval = getterConfig.processingInterval ?? DEFAULT_GETTER_PROCESSING_INTERVAL;
    const maxBlocks = getterConfig.maxBlocks ?? DEFAULT_GETTER_MAX_BLOCKS;

    // Retrieve private key from global configuration.
    const privateKey = configService.globalConfig.privateKey
    // Throw an error if private key is missing.
    if (privateKey == undefined) {
        throw Error(`Failed to load Layer Zero module: 'privateKey' missing`);
    }

    // Return global Layer Zero configuration settings.
    return {
        retryInterval,
        processingInterval,
        maxBlocks,
        privateKey,
    };
}

// Function to load worker data for Layer Zero.
async function loadWorkerData(
    configService: ConfigService,
    monitorService: MonitorService,
    loggerService: LoggerService,
    chainConfig: ChainConfig,
    globalConfig: GlobalLayerZeroConfig,
): Promise<LayerZeroWorkerData> {
    // Retrieve chain-specific configuration settings.
    const chainId = chainConfig.chainId;
    const rpc = chainConfig.rpc;
    try{
    // Retrieve Layer Zero configuration specific to the chain.
    const layerZeroConfig = configService.ambsConfig.get('layerZero');

    // Retrieve incentives address using the getAMBConfig function.
    const incentivesAddress: string | undefined = configService.getAMBConfig<string>(
        'layerZero', 
        'incentivesAddress', 
        chainId.toString(), 
    );
    // Retrieve bridge address using the getAMBConfig function.
    const bridgeAddress: string | undefined = configService.getAMBConfig(
        'layerZero',
        'bridgeAddress',
        chainId.toString(), 
    );
    // Throw an error if incentives address is missing.
    if (incentivesAddress == undefined) {
        throw Error(`Failed to load Layer Zero module: 'incentivesAddress' missing`);
    }
   
    // Throw an error if bridge address is missing.
    if (bridgeAddress == undefined) {
        throw Error(`Failed to load Layer Zero module: 'bridgeAddress' missing`);
    }
    // Create a new MessageChannel for communication between main thread and worker.
    const { port1, port2 } = new MessageChannel();

    // Attach monitor to the second port of the channel.
    await monitorService.attachToMonitor(chainId);

    // Return worker data for Layer Zero.
    return {
        chainId,
        rpc,
        resolver: chainConfig.resolver,
        startingBlock: chainConfig.startingBlock,
        stoppingBlock: chainConfig.stoppingBlock,
        retryInterval: chainConfig.getter.retryInterval ?? globalConfig.retryInterval,
        processingInterval: chainConfig.getter.processingInterval ?? globalConfig.processingInterval,
        maxBlocks: chainConfig.getter.maxBlocks ?? globalConfig.maxBlocks,
        incentivesAddress,
        bridgeAddress,
        privateKey: globalConfig.privateKey,
        monitorPort: port1,
        loggerOptions: loggerService.loggerOptions,
    };
} catch (error) {
    loggerService.error(error, 'Failed to load Layer Zero module: missing configuration.');
    throw error;
}
}

// Main function for initializing Layer Zero workers.
export default async (moduleInterface: CollectorModuleInterface) => {
    const { configService, monitorService, loggerService } = moduleInterface;

    // Load global Layer Zero configuration settings.
    const globalLayerZeroConfig = loadGlobalLayerZeroConfig(configService);

    // Initialize arrays to hold references to GARP and ULNBase workers.
    const GARPWorkers: Record<string, Worker | null> = {};
    const ULNBaseWorkers: Record<string, Worker | null> = {};

    // Iterate through chain configurations and initialize workers.
    for (const [chainId, chainConfig] of configService.chainsConfig) {
        // Load worker data for GARP.
        const GARPWorkerData = await loadWorkerData(
            configService,
            monitorService,
            loggerService,
            chainConfig,
            globalLayerZeroConfig,
        );

        // Load worker data for ULNBase.
        const ULNBaseWorkerData = await loadWorkerData(
            configService,
            monitorService,
            loggerService,
            chainConfig,
            globalLayerZeroConfig,
        );

        // Create and initialize GARP worker.
        const GARPWorker = new Worker(join(__dirname, 'GARPWorker.js'), {
            workerData: GARPWorkerData,
            transferList: [GARPWorkerData.monitorPort]
        });
        GARPWorkers[GARPWorkerData.chainId] = GARPWorker;

        // Handle errors and exit events for GARP worker.
        GARPWorker.on('error', (error) =>
            loggerService.fatal(error, 'Error on GARP worker.'),
        );
        GARPWorker.on('exit', (exitCode) => {
            GARPWorkers[chainId] = null;
            loggerService.info(
                { exitCode, chainId },
                `GARP worker exited.`,
            );
        });

        // Create and initialize ULNBase worker.
        const ULNBaseWorker = new Worker(join(__dirname, 'ULNBaseWorker.js'), {
            workerData: ULNBaseWorkerData,
            transferList: [ULNBaseWorkerData.monitorPort]
        });
        ULNBaseWorkers[ULNBaseWorkerData.chainId] = ULNBaseWorker;

        // Handle errors and exit events for ULNBase worker.
        ULNBaseWorker.on('error', (error) =>
            loggerService.fatal(error, 'Error on ULNBase worker.'),
        );
        ULNBaseWorker.on('exit', (exitCode) => {
            ULNBaseWorkers[chainId] = null;
            loggerService.info(
                { exitCode, chainId },
                `ULNBase worker exited.`,
            );
        });
    };

    // Initiate status log interval
    const logStatus = () => {
        const activeGARPWorkers = [];
        const inactiveGARPWorkers = [];
        const activeULNBaseWorkers = [];
        const inactiveULNBaseWorkers = [];

        // Iterate through GARP workers and determine active/inactive status.
        for (const chainId of Object.keys(GARPWorkers)) {
            if (GARPWorkers[chainId] != null) activeGARPWorkers.push(chainId);
            else inactiveGARPWorkers.push(chainId);
        }

        // Iterate through ULNBase workers and determine active/inactive status.
        for (const chainId of Object.keys(ULNBaseWorkers)) {
            if (ULNBaseWorkers[chainId] != null) activeULNBaseWorkers.push(chainId);
            else inactiveULNBaseWorkers.push(chainId);
        }

        // Log the status of Layer Zero collector workers.
        const status = {
            activeGARPWorkers,
            inactiveGARPWorkers: inactiveGARPWorkers,
            activeULNBaseWorkers,
            inactiveULNBaseWorkers,
        };
        loggerService.info(status, 'Layer Zero collector workers status.');
    };
    // Set interval to log worker status.
    setInterval(logStatus, STATUS_LOG_INTERVAL);
};
