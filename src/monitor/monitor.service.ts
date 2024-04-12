import { Global, Injectable, OnModuleInit } from '@nestjs/common';
import { join } from 'path';
import { LoggerOptions } from 'pino';
import { Worker, MessagePort } from 'worker_threads';
import { ConfigService } from 'src/config/config.service';
import { LoggerService, STATUS_LOG_INTERVAL } from 'src/logger/logger.service';
import { MonitorGetPortMessage, MonitorGetPortResponse } from './monitor.types';
import { tryErrorToString } from 'src/common/utils';
import { ChainConfig } from 'src/config/config.types';

export const DEFAULT_MONITOR_INTERVAL = 5000;
export const DEFAULT_MONITOR_BLOCK_DELAY = 0;


interface DefaultMonitorWorkerData {
    interval: number,
    blockDelay: number,
}

export interface MonitorWorkerData {
    chainId: string,
    chainName: string,
    rpc: string,
    blockDelay: number,
    interval: number,
    loggerOptions: LoggerOptions
}

@Global()
@Injectable()
export class MonitorService implements OnModuleInit {
    private workers: Record<string, Worker | null> = {};
    private requestPortMessageId = 0;

    constructor(
        private readonly configService: ConfigService,
        private readonly loggerService: LoggerService,
    ) {}

    onModuleInit() {
        this.loggerService.info(`Starting Monitor on all chains...`);

        this.initializeWorkers();

        this.initiateIntervalStatusLog();
    }

    private initializeWorkers(): void {
        const defaultWorkerConfig = this.loadDefaultWorkerConfig();

        for (const [chainId, chainConfig] of this.configService.chainsConfig) {

            const workerData = this.loadWorkerConfig(chainConfig, defaultWorkerConfig);

            const worker = new Worker(join(__dirname, 'monitor.worker.js'), {
                workerData
            });
            this.workers[chainId] = worker;

            worker.on('error', (error) => {
                this.loggerService.fatal(
                    { error: tryErrorToString(error), chainId },
                    `Error on monitor worker.`,
                );
            });

            worker.on('exit', (exitCode) => {
                this.workers[chainId] = null;
                this.loggerService.fatal(
                    { exitCode, chainId },
                    `Monitor worker exited.`,
                );
            });
        }
    }

    private loadDefaultWorkerConfig(): DefaultMonitorWorkerData {
        const globalMonitorConfig = this.configService.globalConfig.monitor;

        const blockDelay = globalMonitorConfig.blockDelay ?? DEFAULT_MONITOR_BLOCK_DELAY;
        const interval = globalMonitorConfig.interval ?? DEFAULT_MONITOR_INTERVAL;

        return {
            interval,
            blockDelay,
        }
    }

    private loadWorkerConfig(
        chainConfig: ChainConfig,
        defaultConfig: DefaultMonitorWorkerData
    ): MonitorWorkerData {

        const chainMonitorConfig = chainConfig.monitor;
        return {
            chainId: chainConfig.chainId,
            chainName: chainConfig.name,
            rpc: chainConfig.rpc,
            blockDelay: chainMonitorConfig.blockDelay ?? defaultConfig.blockDelay,
            interval: chainMonitorConfig.interval ?? defaultConfig.interval,
            loggerOptions: this.loggerService.loggerOptions
        };
    }

    private initiateIntervalStatusLog(): void {
        const logStatus = () => {
            const activeWorkers = [];
            const inactiveWorkers = [];
            for (const chainId of Object.keys(this.workers)) {
                if (this.workers[chainId] != null) activeWorkers.push(chainId);
                else inactiveWorkers.push(chainId);
            }
            const status = {
                activeWorkers,
                inactiveWorkers,
            };
            this.loggerService.info(status, 'Monitor workers status.');
        };
        setInterval(logStatus, STATUS_LOG_INTERVAL);
    }


    private getNextRequestPortMessageId(): number {
        return this.requestPortMessageId++;
    }

    async attachToMonitor(chainId: string): Promise<MessagePort> {
        const worker = this.workers[chainId];

        if (worker == undefined) {
            throw new Error(`Monitor does not exist for chain ${chainId}`);
        }

        const messageId = this.getNextRequestPortMessageId();
        const portPromise = new Promise<MessagePort>((resolve) => {
            const listener = (data: MonitorGetPortResponse) => {
                if (data.messageId == messageId) {
                    worker.off("message", listener);
                    resolve(data.port);
                }
            };
            worker.on("message", listener);

            const portMessage: MonitorGetPortMessage = { messageId };
            worker.postMessage(portMessage);
        });

        return portPromise;
    }
}
