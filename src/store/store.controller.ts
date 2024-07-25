import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { LoggerService } from 'src/logger/logger.service';
import { Store } from './store.lib';
import { PrioritiseMessage } from './store.types';


@Controller()
export class StoreController {

    private readonly store: Store;

    constructor(
        private readonly loggerService: LoggerService,
    ) {
        this.store = new Store();
    }

    @Get('getAMBMessages')
    async getAMBMessages(@Query() query: any): Promise<any | undefined> {
        const chainId = query.chainId;
        const txHash = query.txHash;

        if (chainId == undefined || txHash == undefined) {
            return undefined; //TODO return error
        }

        const amb = await this.store.getAMBMessagesByTransactionHash(chainId, txHash);
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

        await this.store.setAMBMessagePriority(
            body.sourceChainId,
            body.messageIdentifier,
            true,
        );
    }
}
