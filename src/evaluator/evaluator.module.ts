import { Module } from '@nestjs/common';
import { LoggerModule } from 'src/logger/logger.module';
import { EvaluatorService } from './evaluator.service';

@Module({
  providers: [EvaluatorService],
  exports: [EvaluatorService],
  imports: [LoggerModule],
})
export class EvaluatorModule {}
