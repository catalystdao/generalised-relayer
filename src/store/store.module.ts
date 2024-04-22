import { Module } from '@nestjs/common';
import { StoreController } from './store.controller';
import { StoreGateway } from './store.gateway';

@Module({
    controllers: [StoreController],
    providers: [StoreGateway],
    imports: [],
})
export class StoreModule {}
