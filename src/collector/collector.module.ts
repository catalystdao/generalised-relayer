import { Module } from '@nestjs/common';
import { SubmitterModule } from 'src/submitter/submitter.module';
import { CollectorController } from './collector.controller';

@Module({
  controllers: [CollectorController],
  imports: [SubmitterModule],
})
export class CollectorModule {}
