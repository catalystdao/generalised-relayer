import { Global, Module } from '@nestjs/common';
import { MonitorService } from './monitor.service';

@Global()
@Module({
    providers: [MonitorService],
    exports: [MonitorService],
})
export class MonitorModule {}
