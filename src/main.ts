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
      globalConfig: configService.globalConfig,
      chainsConfig: Object.fromEntries(configService.chainsConfig.entries()),
      ambConfig: Object.fromEntries(configService.ambsConfig.entries()),
    },
    `Relayer initialized.`,
  );
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  const configService = app.get(ConfigService);
  const loggerService = app.get(LoggerService);

  logLoadedOptions(configService, loggerService);

  await app.listen(configService.globalConfig.port);
}
void bootstrap();
