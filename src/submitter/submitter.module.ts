import { Module } from '@nestjs/common';
import { LoggerModule } from 'src/logger/logger.module';
import { SubmitterService } from './submitter.service';
import { SubmitterController } from './submitter.controller';

@Module({
  controllers: [SubmitterController],
  providers: [SubmitterService],
  exports: [SubmitterService],
  imports: [LoggerModule],
})
export class SubmitterModule {}
