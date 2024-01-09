import { Module } from '@nestjs/common';
import { LoggerModule } from 'src/logger/logger.module';
import { SubmitterModule } from 'src/submitter/submitter.module';
import { CollectorController } from './collector.controller';

@Module({
  controllers: [CollectorController],
  imports: [LoggerModule, SubmitterModule],
})
export class CollectorModule {}
