import { Module } from '@nestjs/common';
import { EvaluatorService } from './evaluator.service';

@Module({
  providers: [EvaluatorService],
  exports: [EvaluatorService],
})
export class EvaluatorModule {}
