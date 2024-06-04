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

    const workers: Record<string, Worker | null> = {};

    for (const [chainId, chainConfig] of configService.chainsConfig) {
        const workerData = await loadWorkerData(
            configService,
            monitorService,
            loggerService,
            chainConfig,
            globalLayerZeroConfig,
        );

        const worker = new Worker(join(__dirname, 'worker.js'), {
            workerData,
            transferList: [workerData.monitorPort]
        });
        workers[workerData.chainId] = worker;

        worker.on('error', (error) =>
            loggerService.fatal(error, 'Error on Layer Zero collector service worker.'),
        );

        worker.on('exit', (exitCode) => {
            workers[chainId] = null;
            loggerService.info(
                { exitCode, chainId },
                `Layer Zero collector service worker exited.`,
            );
        });
    };

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
        loggerService.info(status, 'Layer Zero collector workers status.');
    };
    setInterval(logStatus, STATUS_LOG_INTERVAL);
};
