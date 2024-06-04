import { join } from 'path';
import { Worker, MessagePort } from 'worker_threads';
import { CollectorModuleInterface } from '../collector.controller';
import {
    DEFAULT_GETTER_RETRY_INTERVAL,
    DEFAULT_GETTER_PROCESSING_INTERVAL,
    DEFAULT_GETTER_MAX_BLOCKS,
} from 'src/getter/getter.service';
import { LoggerService, STATUS_LOG_INTERVAL } from 'src/logger/logger.service';
import { ConfigService } from 'src/config/config.service';
import { ChainConfig } from 'src/config/config.types';
import { LoggerOptions } from 'pino';
import { MonitorService } from 'src/monitor/monitor.service';

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
    bridgeAddress: string;
    privateKey: string;
    monitorPort: MessagePort;
    loggerOptions: LoggerOptions;
}

function loadGlobalLayerZeroConfig(configService: ConfigService): GlobalLayerZeroConfig {
    const layerZeroConfig = configService.ambsConfig.get('layerZero');
    if (layerZeroConfig == undefined) {
        throw Error(`Failed to load Layer Zero module: 'layerZero' configuration not found.`);
    }

    const getterConfig = configService.globalConfig.getter;
    const retryInterval = getterConfig.retryInterval ?? DEFAULT_GETTER_RETRY_INTERVAL;
    const processingInterval = getterConfig.processingInterval ?? DEFAULT_GETTER_PROCESSING_INTERVAL;
    const maxBlocks = getterConfig.maxBlocks ?? DEFAULT_GETTER_MAX_BLOCKS;

    const privateKey = layerZeroConfig.globalProperties['privateKey'];
    if (privateKey == undefined) {
        throw Error(`Failed to load Layer Zero module: 'privateKey' missing`);
    }

    return {
        retryInterval,
        processingInterval,
        maxBlocks,
        privateKey,
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
    const bridgeAddress: string | undefined = configService.getAMBConfig(
        'layerZero',
        'bridgeAddress',
        chainId,
    ) as string;

    const incentivesAddress = configService.getAMBConfig(
        'layerZero',
        'incentivesAddress',
        chainId,
    ) as string;

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
        monitorPort: await monitorService.attachToMonitor(chainId),
        loggerOptions: loggerService.loggerOptions,
    };
}

export default async (moduleInterface: CollectorModuleInterface) => {
    const { configService, monitorService, loggerService } = moduleInterface;

    const globalLayerZeroConfig = loadGlobalLayerZeroConfig(configService);

    const GARPWorkers: Record<string, Worker | null> = {};
    const ULNBaseWorkers: Record<string, Worker | null> = {};

    for (const [chainId, chainConfig] of configService.chainsConfig) {
        const workerData = await loadWorkerData(
            configService,
            monitorService,
            loggerService,
            chainConfig,
            globalLayerZeroConfig,
        );

        const GARPWorker = new Worker(join(__dirname, 'GARPWorker.js'), {
            workerData,
            transferList: [workerData.monitorPort]
        });
        GARPWorkers[workerData.chainId] = GARPWorker;

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

        const ULNBaseWorker = new Worker(join(__dirname, 'ULNBaseWorker.js'), {
            workerData,
            transferList: [workerData.monitorPort]
        });
        ULNBaseWorkers[workerData.chainId] = ULNBaseWorker;

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
