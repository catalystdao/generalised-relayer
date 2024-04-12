import { Module } from '@nestjs/common';
import { GetterService } from './getter.service';

@Module({
  providers: [GetterService],
})
export class GetterModule {}
