import { Controller, OnModuleInit } from '@nestjs/common';
import { join } from 'path';
// import { bountyToDTO } from 'src/common/utils';
import { Worker } from 'worker_threads';
import { ConfigService } from 'src/config/config.service';
import { LoggerService, STATUS_LOG_INTERVAL } from 'src/logger/logger.service';

export const DEFAULT_GETTER_INTERVAL = 5000;

@Controller()
export class GetterController implements OnModuleInit {
  private workers: Record<string, Worker | null> = {};

  constructor(
    private readonly configService: ConfigService,
    private readonly loggerService: LoggerService,
  ) {}

  onModuleInit() {
    this.loggerService.info(`Starting Bounty Collection on all chains...`);

    const configDefaultGetterInterval =
      this.configService.relayerConfig.getter['interval'];
    if (configDefaultGetterInterval == undefined) {
      this.loggerService.warn(
        `No 'getter: interval' configuration set. Defaulting to ${DEFAULT_GETTER_INTERVAL}`,
      );
    }
    const defaultGetterInterval =
      configDefaultGetterInterval ?? DEFAULT_GETTER_INTERVAL;

    const defaultMaxBlocks =
      this.configService.relayerConfig.getter['maxBlocks'] ?? undefined;

    this.configService.chainsConfig.forEach((chainConfig) => {
      const chainId = chainConfig.chainId;

      const incentivesAddresses = Array.from(
        this.configService.ambsConfig.values(),
      ).map((amb) => amb.getIncentivesAddress(chainId));

      const worker = new Worker(join(__dirname, 'getter.service.js'), {
        workerData: {
          chainConfig,
          incentivesAddresses,
          interval: chainConfig.getter['interval'] ?? defaultGetterInterval,
          blockDelay: chainConfig.blockDelay ?? 0,
          maxBlocks: chainConfig.getter['maxBlocks'] ?? defaultMaxBlocks,
          loggerOptions: this.loggerService.loggerOptions,
        },
      });
      this.workers[chainId] = worker;

      worker.on('error', (error) =>
        this.loggerService.fatal(
          error,
          `Error on getter worker (chain ${chainConfig.chainId}).`,
        ),
      );

      worker.on('exit', (exitCode) => {
        this.workers[chainConfig.chainId] = null;
        this.loggerService.info(
          `Getter worker exited with code ${exitCode} (chain ${chainConfig.chainId}).`,
        );
      });
    });

    this.initiateIntervalStatusLog();
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
      this.loggerService.info(status, 'Getter workers status.');
    };
    setInterval(logStatus, STATUS_LOG_INTERVAL);
  }
}
