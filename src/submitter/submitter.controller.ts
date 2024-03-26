import { Body, Controller, Post } from '@nestjs/common';
import { LoggerService } from 'src/logger/logger.service';
import { Store } from 'src/store/store.lib';
import { PrioritiseMessage } from 'src/store/types/store.types';

@Controller()
export class SubmitterController {

  constructor(
    private readonly loggerService: LoggerService,
  ) {}

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
