import { Controller, OnModuleInit } from '@nestjs/common';
import { ConfigService } from 'src/config/config.service';
import { LoggerService } from 'src/logger/logger.service';
import { SubmitterService } from 'src/submitter/submitter.service';

export interface CollectorModuleInterface {
  configService: ConfigService;
  loggerService: LoggerService;
  submitterService: SubmitterService;
}

@Controller()
export class CollectorController implements OnModuleInit {
  constructor(
    private readonly configService: ConfigService,
    private readonly loggerService: LoggerService,
    private readonly submitterService: SubmitterService,
  ) {}

  /**
   * Starts all the different AMB's
   */
  async onModuleInit() {
    await this.loadAMBModules();
  }

  async loadAMBModules() {
    const ambs = Array.from(this.configService.ambsConfig.keys());

    const moduleInterface: CollectorModuleInterface = {
      configService: this.configService,
      loggerService: this.loggerService,
      submitterService: this.submitterService,
    };

    for (const amb of ambs) {
      const module = await import(`./${amb}/${amb}`);
      module.default(moduleInterface);
    }
  }

}
