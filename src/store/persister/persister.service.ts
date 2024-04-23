import { Injectable } from '@nestjs/common';
import { join } from 'path';
import { Worker } from 'worker_threads';
import { ConfigService } from 'src/config/config.service';
import { LoggerService } from 'src/logger/logger.service';

@Injectable()
export class PersisterService {
    private worker?: Worker;

    private chains: string[] = [];

    constructor(
        private readonly configService: ConfigService,
        private readonly loggerService: LoggerService,
    ) {}

    async onModuleInit(): Promise<void> {
        // Do we need to start persister?
        const startPersister = this.configService.globalConfig.persister.enabled;
        this.loggerService.info(
            `Persister is ${startPersister ? 'enabled' : 'disabled'}`,
        );
        if (!startPersister) return;

        this.loggerService.info(`Starting the persister...`);

        const chains: string[] = [];
        for (const [, chainConfig] of this.configService.chainsConfig) {
            chains.push(chainConfig.chainId);
        }
        this.chains = chains;

        const worker = new Worker(join(__dirname, 'persister.worker.js'), {
            workerData: {
                postgresConnectionString:
                    this.configService.globalConfig.persister.postgresString,
                chains: chains,
                loggerOptions: this.loggerService.loggerOptions,
            },
        });

        await this.setSubscriptions(worker);

        this.worker = worker;
    }

    async setSubscriptions(worker: Worker) {
        worker.on('error', (error) =>
            this.loggerService.fatal(error, `Error on persister.`),
        );

        worker.on('exit', (exitCode) => {
            this.loggerService.fatal({ exitCode }, `Persister exited.`);
            // Sometimes the postgres connection is dropped, we need to recover from that case.
            if (exitCode === 1) {
                setTimeout(() => {
                    this.loggerService.info(`Starting new persister`);
                    const newWorker = new Worker(join(__dirname, 'persister.worker.js'), {
                        workerData: {
                            postgresConnectionString:
                                this.configService.globalConfig.persister.postgresString,
                            chains: this.chains,
                            loggerOptions: this.loggerService.loggerOptions,
                        },
                    });

                    void this.setSubscriptions(newWorker);
                    this.worker = newWorker;
                });
            }
        });
    }
}
