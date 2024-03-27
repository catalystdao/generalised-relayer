import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { LoggerService } from 'src/logger/logger.service';
import { Store } from './store.lib';
import { PrioritiseMessage } from './types/store.types';


@Controller()
export class StoreController {
  constructor(
    private readonly loggerService: LoggerService,
  ) {}

  //TODO set a more descriptive endpoint name.
  @Get('getAMBs')
  async getAMBs(@Query() query: any): Promise<any | undefined> {
    const chainId = query.chainId;
    const txHash = query.txHash;

    if (chainId == undefined || txHash == undefined) {
      return undefined; //TODO return error
    }

    const store = new Store(chainId);
    const amb = await store.getAMBsByTxHash(chainId, txHash);
    if (amb != null) return JSON.stringify(amb);
  }

  @Post('prioritiseAMBMessage')
  async prioritiseAMBMessage(@Body() body: PrioritiseMessage) {
    //TODO schema validate request

    this.loggerService.info(
      {
        messageIdentifier: body.messageIdentifier,
        amb: body.amb,
        sourceChainId: body.sourceChainId,
        destinationChainId: body.destinationChainId,
      },
      `Message prioritisation requested.`
    )

    const store = new Store();
    await store.setAmbPriority(
      body.messageIdentifier,
      true,
    );
  }
}
