import { join } from 'path';
import { Worker } from 'worker_threads';
import { LoggerService, STATUS_LOG_INTERVAL } from 'src/logger/logger.service';
import { WormholeConfig, WormholeRecoveryWorkerData } from './wormhole.types';
import { tryErrorToString } from 'src/common/utils';

function loadRecoveryWorkerData(
    chainId: string,
    wormholeConfig: WormholeConfig,
): WormholeRecoveryWorkerData | null {
    const wormholeChainConfig = wormholeConfig.wormholeChainConfigs.get(chainId);
    if (wormholeChainConfig == undefined) {
        return null;
    }

    const startingBlock = wormholeChainConfig.startingBlock;
    if (startingBlock == undefined) {
        return null;
    }

    return {
        ...wormholeChainConfig,
        startingBlock,
        wormholeChainIdMap: wormholeConfig.wormholeChainIdMap,
        loggerOptions: wormholeConfig.loggerOptions,
    };
}

export function initiateRecoveryWorkers(
    wormholeConfig: WormholeConfig,
    loggerService: LoggerService,
): void {
    loggerService.info('Starting the wormhole recovery workers...');

    const workers: Record<string, Worker | null> = {};

    for (const [chainId] of wormholeConfig.wormholeChainConfigs) {
        // Spawn a worker for every Wormhole implementation
        const workerData = loadRecoveryWorkerData(chainId, wormholeConfig);

        if (workerData) {
            const worker = new Worker(
                join(__dirname, 'wormhole-recovery.worker.js'),
                {
                    workerData,
                },
            );
            workers[chainId] = worker;

            worker.on('error', (error) =>
                loggerService.fatal(
                    { error: tryErrorToString(error), chainId: chainId },
                    'Error on Wormhole recovery service worker.',
                ),
            );

            worker.on('exit', (exitCode) => {
                workers[chainId] = null;
                loggerService.info(
                    { exitCode, chainId: chainId },
                    `Wormhole recovery service worker exited.`,
                );
            });
        }
    }

    // Initiate status log interval
    if (Object.keys(workers).length > 0) {
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
            loggerService.info(status, 'Wormhole collector recovery workers status.');
        };
        setInterval(logStatus, STATUS_LOG_INTERVAL);
    } else {
        loggerService.info('No Wormhole recovery worker started.');
    }
}
