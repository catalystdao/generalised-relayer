import { Module } from '@nestjs/common';
import { MonitorService } from './monitor.service';

@Module({
    providers: [MonitorService],
    exports: [MonitorService],
})
export class MonitorModule {}
