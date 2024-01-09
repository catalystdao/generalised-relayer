import { Module } from '@nestjs/common';
import { LoggerModule } from 'src/logger/logger.module';
import { SubmitterService } from './submitter.service';

@Module({
  providers: [SubmitterService],
  exports: [SubmitterService],
  imports: [LoggerModule],
})
export class SubmitterModule {}
