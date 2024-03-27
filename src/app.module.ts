import { Module } from '@nestjs/common';
import { CollectorModule } from './collector/collector.module';
import { ConfigModule } from './config/config.module';
import { EvaluatorModule } from './evaluator/evaluator.module';
import { GetterModule } from './getter/getter.module';
import { LoggerModule } from './logger/logger.module';
import { SubmitterModule } from './submitter/submitter.module';
import { PersisterModule } from './store/persister/persister.module';
import { StoreModule } from './store/store.module';

@Module({
  imports: [
    ConfigModule,
    LoggerModule,
    GetterModule,
    EvaluatorModule,
    CollectorModule,
    SubmitterModule,
    PersisterModule,
    StoreModule,
  ],
})
export class AppModule {}
