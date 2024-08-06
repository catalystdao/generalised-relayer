import { Module } from '@nestjs/common';
import { CollectorModule } from './collector/collector.module';
import { GetterModule } from './getter/getter.module';
import { LoggerModule } from './logger/logger.module';
import { SubmitterModule } from './submitter/submitter.module';
import { PersisterModule } from './store/persister/persister.module';
import { StoreModule } from './store/store.module';
import { MonitorModule } from './monitor/monitor.module';
import { PricingModule } from './pricing/pricing.module';
import { ConfigModule } from './config/config.module';

@Module({
    imports: [
        ConfigModule,
        LoggerModule,
        MonitorModule,
        GetterModule,
        CollectorModule,
        PricingModule,
        SubmitterModule,
        PersisterModule,
        StoreModule,
    ],
})
export class AppModule { }