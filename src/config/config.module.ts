import { DynamicModule, Global, Module } from '@nestjs/common';
import { ConfigService } from './config.service';

@Global()
@Module({
    exports: [ConfigService],
    providers: [ConfigService],
})
export class ConfigModule {
    static withConfigFile(configFilePath?: string): DynamicModule {
        return {
            module: ConfigModule,
            providers: [
                {
                    provide: ConfigService,
                    useFactory: () => new ConfigService(configFilePath),
                },
            ],
            exports: [ConfigService],
        };
    }
    static defaultConfig(): DynamicModule {
        return {
            module: ConfigModule,
            providers: [
                {
                    provide: ConfigService,
                    useFactory: () => new ConfigService(),
                },
            ],
            exports: [ConfigService],
        };
    }
}