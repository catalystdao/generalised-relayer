
import pino from 'pino';
import Transport from 'winston-transport';

// Custom transport to emit the logs generated within a 'winston' logger to a 'pino' logger.
export class PinoLoggerTransport extends Transport {
    constructor(private readonly logger: pino.Logger) {
        super({});
    }

    override log(info: any, callback: () => any) {

        const reportedLevel = info['level'];

        const logObject: Record<string, any> = {};
        for (const property of Object.getOwnPropertyNames(info)) {
            if (property == 'level') {
                continue;
            }
            logObject[property] = info[property];
        }

        // Try to emit the log using the 'level' reported by the Winston logger. On failure default
        // to 'info'.
        try {
            this.logger[reportedLevel as pino.Level](logObject)
        } catch {
            this.logger.info({
                unsupportedLogLevel: reportedLevel,
                ...logObject,
            });
        }

        callback();
    }

}
