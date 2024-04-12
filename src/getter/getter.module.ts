import { Module } from '@nestjs/common';
import { LoggerModule } from 'src/logger/logger.module';
import { GetterService } from './getter.service';

@Module({
  providers: [GetterService],
  imports: [LoggerModule],
})
export class GetterModule {}
