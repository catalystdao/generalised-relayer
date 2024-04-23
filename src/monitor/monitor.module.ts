import { Global, Module } from '@nestjs/common';
import { MonitorService } from './monitor.service';
import { MonitorGateway } from './monitor.gateway';

@Global()
@Module({
    providers: [MonitorService, MonitorGateway],
    exports: [MonitorService],
})
export class MonitorModule {}
