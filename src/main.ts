import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { AppModule } from './app.module';
import { ConfigService } from './config/config.service';
import { LoggerService } from './logger/logger.service';
import { existsSync } from 'fs';
import { resolve } from 'path';

function logLoadedOptions(
    configService: ConfigService,
    loggerService: LoggerService,
) {
    // Log the loaded configuration
    loggerService.info(
        {
            mode: configService.nodeEnv,
            globalConfig: configService.globalConfig,
            chainsConfig: Object.fromEntries(configService.chainsConfig.entries()),
            ambConfig: Object.fromEntries(configService.ambsConfig.entries()),
        },
        `Relayer initialized.`,
    );
}

async function bootstrap() {
    const configFilePath = process.env['CONFIG_FILE_PATH'];
    let app;

    if (configFilePath && existsSync(resolve(configFilePath))) {
        app = await NestFactory.create(AppModule.initiateWithConfig(configFilePath));
    } else {
        app = await NestFactory.create(AppModule.initiateWithConfig());
    }

    app.useWebSocketAdapter(new WsAdapter(app));

    const configService = app.get(ConfigService);
    const loggerService = app.get(LoggerService);

    // Wait for the privateKey to be ready
    await configService.globalConfig.privateKey;

    logLoadedOptions(configService, loggerService);

    await configService.isReady;

    await app.listen(configService.globalConfig.port);
}
void bootstrap();
