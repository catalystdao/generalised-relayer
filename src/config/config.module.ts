import { Global, Module } from '@nestjs/common';
import { ConfigService } from './config.service';
import { HttpModule } from '@nestjs/axios';

@Global()
@Module({
    imports: [HttpModule],
    exports: [ConfigService],
    providers: [ConfigService],
})
export class ConfigModule {}
