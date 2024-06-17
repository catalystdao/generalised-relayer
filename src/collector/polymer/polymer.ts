import { join } from 'path';
import { LoggerOptions } from 'pino';
import { ConfigService } from 'src/config/config.service';
import { ChainConfig } from 'src/config/config.types';
import {
    DEFAULT_GETTER_RETRY_INTERVAL,
    DEFAULT_GETTER_PROCESSING_INTERVAL,
    DEFAULT_GETTER_MAX_BLOCKS,
} from 'src/getter/getter.service';
import { LoggerService, STATUS_LOG_INTERVAL } from 'src/logger/logger.service';
import { Worker, MessagePort } from 'worker_threads';
import { CollectorModuleInterface } from '../collector.controller';
import { MonitorService } from 'src/monitor/monitor.service';

interface GlobalPolymerConfig {
    retryInterval: number;
    processingInterval: number;
    maxBlocks: number | null;
}

export interface PolymerWorkerData {
    chainId: string;
    rpc: string;
    resolver: string | null;
    startingBlock?: number;
    stoppingBlock?: number;
    retryInterval: number;
    processingInterval: number;
    maxBlocks: number | null;
    incentivesAddress: string;
    monitorPort: MessagePort;
    loggerOptions: LoggerOptions;
    polymerAddress: string;
    polymerChannels: { [channel: string]: string }
}

function loadGlobalPolymerConfig(
    configService: ConfigService,
): GlobalPolymerConfig {
    const polymerConfig = configService.ambsConfig.get('polymer');
    if (polymerConfig == undefined) {
        throw Error(
            `Failed to load Polymer module: 'polymer' configuration not found.`,
        );
    }

    const getterConfig = configService.globalConfig.getter;
    const retryInterval = getterConfig.retryInterval ?? DEFAULT_GETTER_RETRY_INTERVAL;
    const processingInterval = getterConfig.processingInterval ?? DEFAULT_GETTER_PROCESSING_INTERVAL;
    const maxBlocks = getterConfig.maxBlocks ?? DEFAULT_GETTER_MAX_BLOCKS;

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
    globalConfig: GlobalPolymerConfig,
): Promise<PolymerWorkerData | null> {
    const chainId = chainConfig.chainId;
    const rpc = chainConfig.rpc;

    const incentivesAddress: string | undefined = configService.getAMBConfig(
        'polymer',
        'incentivesAddress',
        chainId,
    );

    const polymerAddress: string | undefined = configService.getAMBConfig(
        'polymer',
        'bridgeAddress',
        chainConfig.chainId,
    );

    const polymerChannels: { [channel: string]: string } = configService.getAMBConfig(
        'polymer',
        'channels',
        chainConfig.chainId,
    );

    if (
        incentivesAddress == undefined ||
        polymerAddress == undefined
    ) {
        return null;
    };

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
        polymerAddress,
        polymerChannels,
        monitorPort: await monitorService.attachToMonitor(chainId),
        loggerOptions: loggerService.loggerOptions,
    };
}

export default async (moduleInterface: CollectorModuleInterface) => {
    const { configService, monitorService, loggerService } = moduleInterface;

    const globalPolymerConfig = loadGlobalPolymerConfig(configService);

    const workers: Record<string, Worker | null> = {};

    for (const [chainId, chainConfig] of configService.chainsConfig) {
        const workerData = await loadWorkerData(
            configService,
            monitorService,
            loggerService,
            chainConfig,
            globalPolymerConfig,
        );

        if (workerData) {
            const worker = new Worker(join(__dirname, 'polymer.worker.js'), {
                workerData,
                transferList: [workerData.monitorPort]
            });
            workers[workerData.chainId] = worker;

            worker.on('error', (error) =>
                loggerService.fatal(
                    error,
                    'Error on polymer collector service worker.',
                ),
            );

            worker.on('exit', (exitCode) => {
                workers[chainId] = null;
                loggerService.info(
                    { exitCode, chainId },
                    `Polymer collector service worker exited.`,
                );
            });
        } else {
            loggerService.info(
                { chainId },
                `Polymer configuration for chain not found or incomplete.`,
            );
        }
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
        loggerService.info(status, 'Polymer collector workers status.');
    };
    setInterval(logStatus, STATUS_LOG_INTERVAL);
};
