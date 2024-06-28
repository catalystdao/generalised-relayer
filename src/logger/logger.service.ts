import { Injectable } from '@nestjs/common';
import { LoggerOptions, pino } from 'pino';
import { ConfigService } from 'src/config/config.service';

export const STATUS_LOG_INTERVAL = 60000; //TODO move to config

@Injectable()
export class LoggerService {
    readonly logger: pino.Logger;
    readonly loggerOptions: pino.LoggerOptions;

    constructor(configService: ConfigService) {
        this.loggerOptions = this.loadLoggerOptions(
            configService.globalConfig.logLevel,
        );
        this.logger = pino(this.loggerOptions);
    }

    private loadLoggerOptions(logLevel?: string): LoggerOptions {
        const baseOptions: LoggerOptions = {
            level: logLevel ?? 'info',
            base: { pid: process.pid }, // Remove default 'hostname' key from logs
            redact: [
                'privateKey',
                '*.privateKey',
                '*.*.privateKey',
                '*.*.*.privateKey',
                '*.*.*.*.privateKey',
            ],
        };

        if (logLevel === 'debug') {
            const transport = {
                target: 'pino-pretty',
                options: {
                    colorize: true,
                    translateTime: 'SYS:standard',
                },
            };

            return {
                ...baseOptions,
                transport,
            };
        } else {
            return baseOptions;
        }
    }

    fatal(obj: any, msg?: string | undefined, ...args: any[]): void {
        this.logger.fatal(obj, msg, args);
    }

    error(obj: any, msg?: string | undefined, ...args: any[]): void {
        this.logger.error(obj, msg, args);
    }

    warn(obj: any, msg?: string | undefined, ...args: any[]): void {
        this.logger.warn(obj, msg, args);
    }

    info(obj: any, msg?: string | undefined, ...args: any[]): void {
        this.logger.info(obj, msg, args);
    }

    debug(obj: any, msg?: string | undefined, ...args: any[]): void {
        this.logger.debug(obj, msg, args);
    }
}
