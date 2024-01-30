import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ConfigService } from './config/config.service';
import { LoggerService } from './logger/logger.service';

function logLoadedOptions(
  configService: ConfigService,
  loggerService: LoggerService,
) {
  // Log the loaded configuration
  loggerService.info(
    {
      mode: configService.nodeEnv,
      config: configService.relayerConfig,
    },
    `Loaded relayer configuration.`,
  );
  loggerService.info(
    { config: Object.fromEntries(configService.chainsConfig.entries()) },
    'Loaded chains configuration.',
  );
  loggerService.info(
    { config: Object.fromEntries(configService.ambsConfig.entries()) },
    'Loaded AMBs configuration.',
  );
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  const configService = app.get(ConfigService);
  const loggerService = app.get(LoggerService);

  logLoadedOptions(configService, loggerService);

  await app.listen(configService.relayerConfig.port);
}
void bootstrap();
