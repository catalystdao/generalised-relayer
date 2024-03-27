import { Module } from '@nestjs/common';
import { StoreController } from './store.controller';

@Module({
  controllers: [StoreController],
  imports: [],
})
export class StoreModule {}
