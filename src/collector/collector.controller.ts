import { Controller, Get, OnModuleInit, Post, Req } from '@nestjs/common';
import { ConfigService } from 'src/config/config.service';
import { LoggerService } from 'src/logger/logger.service';
import { SubmitterService } from 'src/submitter/submitter.service';
import { Store } from '../store/store.lib';
import { AssetSwapMetaData } from './interfaces/asset-swap-metadata.interface';
import { AssetSwapRequest } from './interfaces/asset-swap-request.interface';

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

  /**
   * Gets a the amb metadata
   * @returns cdata and destination chain
   */
  @Get('metadata')
  async getCallData(
    @Req() request: Request,
  ): Promise<AssetSwapMetaData | undefined> {
    const body = (await request.json()) as AssetSwapRequest;
    const store = new Store(body.chainId);
    const amb = await store.getAmb(body.swapIdentifier);

    // TODO: decode cdata base on payload.
    // if (amb?.cdata)
    //   return {
    //     destinationChain: amb.destinationChain,
    //     cdata: amb.cdata,
    //   };

    return undefined;
  }

  /**
   * Prioritises relaying a message
   * @param request
   */
  @Post('prioritise')
  async prioritise(@Req() request: Request) {
    const body = (await request.json()) as AssetSwapRequest;
    const store = new Store(body.chainId);
    const amb = await store.getAmb(body.swapIdentifier);

    //TODO implement
  }
}
