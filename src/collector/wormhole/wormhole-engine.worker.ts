import {
    Environment,
    ParsedVaaWithBytes,
    StandardRelayerApp,
    StandardRelayerContext,
} from '@wormhole-foundation/relayer-engine';
import { decodeWormholeMessage } from 'src/collector/wormhole/wormhole.utils';
import { add0X } from 'src/common/utils';
import { workerData } from 'worker_threads';
import { Store } from 'src/store/store.lib';
import { AMBProof } from 'src/store/store.types';
import pino, { LoggerOptions } from 'pino';
import {
    WormholeChainId,
    WormholeRelayerEngineWorkerData,
} from './wormhole.types';
import { fetchVAAs } from './api-utils';
import { Redis } from 'ioredis';
import winston from 'winston';
import { PinoLoggerTransport } from './winston-pino-logger-transport';

// NOTE: the Wormhole relayer engine is only able of scanning new VAAs. For old VAA recovery
// the 'wormhole-recovery' worker is used.

//TODO implement stopping block

const DEFAULT_WORMHOLE_ENGINE_REDIS_DB_INDEX = 0;

const DEFAULT_SPY_HOST = '127.0.0.1';

const WORMHOLE_ENGINE_NAMESPACE = "wormholeEngine";

class WormholeEngineWorker {
    private readonly config: WormholeRelayerEngineWorkerData;

    private readonly logger: pino.Logger;
    private readonly store: Store;

    constructor() {
        this.config = workerData as WormholeRelayerEngineWorkerData;

        this.logger = this.initializeLogger(this.config.loggerOptions);
        this.store = new Store();
    }

    // Initialization helpers
    // ********************************************************************************************

    private initializeLogger(loggerOptions: LoggerOptions): pino.Logger {
        return pino(loggerOptions).child({
            worker: 'collector-wormhole-engine',
        });
    }

    private getCustomWormholeEngineLogger(): winston.Logger {
        return winston.createLogger({
            transports: [
                new PinoLoggerTransport(this.logger)
            ],
            format: winston.format.combine(
                winston.format.splat(),
                winston.format.errors({ stack: true }),
                winston.format.label({ label: 'wormhole-engine-package' }),
                winston.format.json(),
            ),
        });
    }

    private async loadWormholeRelayerEngine(): Promise<StandardRelayerApp<StandardRelayerContext>> {
        const enviroment = this.config.isTestnet
            ? Environment.TESTNET
            : Environment.MAINNET;

        if (this.config.wormholeChainConfigs.size == 0) {
            throw new Error(
                'Unable to start the Wormhole Engine service: no chains specified.',
            );
        }
        const concurrency = this.config.wormholeChainConfigs.size;

        // Set the starting sequences to prevent the relayer-engine from recovering past VAAs.
        // NOTE: The 'starting sequences' should be set via the `missedVaaOptions', however as of
        // relayer-engine v0.3.2 the sequence configuration does not seem to work. Furthermore, the
        // `startingSequenceConfig` does not allow to specify the sequences according to the 'emitter'
        // addresses.
        // TODO this should be done via the `missedVaaOption` configuration of the relayer-engine.
        await this.setStartingSequences();

        const app = new StandardRelayerApp<StandardRelayerContext>(enviroment, {
            name: WORMHOLE_ENGINE_NAMESPACE,
            redis: {
                host: this.config.redisHost,
                port: this.config.redisPort,
                db: this.config.redisDBIndex ?? DEFAULT_WORMHOLE_ENGINE_REDIS_DB_INDEX
            },
            spyEndpoint: `${this.config.spyHost ?? DEFAULT_SPY_HOST}:${this.config.spyPort}`,
            concurrency,
            logger: this.getCustomWormholeEngineLogger()
        });

        return app;
    }

    // Main handler
    // ********************************************************************************************
    async run(): Promise<void> {
        //Listening to multiple chains for messages
        const engine = await this.loadWormholeRelayerEngine();
        const chainsAndAddresses = this.getChainsAndAddresses();

        engine.multiple(chainsAndAddresses, async (ctx) => {
            if (ctx.vaa != undefined) {
                await this.processVAA(ctx.vaa!);
            }
        });

        await engine.listen();
    }

    // Helpers
    // ********************************************************************************************
    private getChainsAndAddresses(): Record<WormholeChainId, string | string[]> {
        const chainsAndAddresses: Record<number, string | string[]> = {};
        this.config.wormholeChainConfigs.forEach(
            (wormholeConfig) => (chainsAndAddresses[wormholeConfig.wormholeChainId] =
                wormholeConfig.incentivesAddress),
        );
        return chainsAndAddresses;
    }

    // Workaround to get the 'starting sequences' set by directly writing to the Redis database used
    // by the Wormhole relayer-engine.
    private async setStartingSequences(): Promise<void> {

        const redis = new Redis(
            this.config.redisPort,
            {
                host: this.config.redisHost,
                db: this.config.redisDBIndex ?? DEFAULT_WORMHOLE_ENGINE_REDIS_DB_INDEX
            }
        );

        for (const [, wormholeConfig] of this.config.wormholeChainConfigs) {

            const wormholeChainId = wormholeConfig.wormholeChainId;

            // Get the most recent VAA for the chainId-emitterAddress combination
            const mostRecentVAAs = await fetchVAAs(
                wormholeChainId,
                wormholeConfig.incentivesAddress,
                this.config.isTestnet,
                0,
                this.logger,
                1,
            );
            const mostRecentVAA = mostRecentVAAs[0];
            const mostRecentSequence = mostRecentVAA?.sequence ?? 0;

            const redisKey = this.getSafeSequenceKey(
                WORMHOLE_ENGINE_NAMESPACE,
                wormholeChainId,
                wormholeConfig.incentivesAddress
            );

            await redis.set(redisKey, mostRecentSequence);

            this.logger.debug(
                {
                    wormholeChainId,
                    startingSequence: mostRecentSequence,
                },
                "Wormhole VAA starting sequence set."
            );
        }
    }

    // Get the Redis key used by the Wormhole relayer-engine to store the sequence after which to
    // recover any missed VAAs.
    private getSafeSequenceKey(
        namespace: string,
        wormholeChainId: number,
        emitterAddress: string,
    ): string {
        const paddedAddress = emitterAddress
            .toLowerCase()
            .replace('0x', '')
            .padStart(64, '0');

        return `{${namespace}}:${namespace}-relays:missedVaasV3:safeSequence:${wormholeChainId}:${paddedAddress}`
    }

    private async processVAA(vaa: ParsedVaaWithBytes): Promise<void> {
        const wormholeInfo = decodeWormholeMessage(
            add0X(vaa.payload.toString('hex')),
        );

        const sourceChainId = this.config.wormholeChainIdMap.get(
            vaa.emitterChain,
        );
        if (sourceChainId == undefined) {
            this.logger.warn(
                {
                    vaa,
                    sourceWormholeChainId: vaa.emitterChain,
                },
                `Failed to process VAA: source chain id given Wormhole chain id not found.`,
            );
            return;
        }

        const destinationChainId = this.config.wormholeChainIdMap.get(
            wormholeInfo.destinationWormholeChainId,
        );

        if (destinationChainId == undefined) {
            this.logger.warn(
                {
                    vaa,
                    destinationWormholeChainId: wormholeInfo.destinationWormholeChainId,
                },
                `Failed to process VAA: destination chain id given Wormhole chain id not found.`,
            );
            return;
        }

        const ambProof: AMBProof = {
            messageIdentifier: wormholeInfo.messageIdentifier,

            amb: 'wormhole',
            fromChainId: sourceChainId,
            toChainId: destinationChainId,

            message: add0X(vaa.bytes.toString('hex')),
            messageCtx: '0x',
        };

        this.logger.info(
            { sequence: vaa.sequence, destinationChainId },
            `Wormhole VAA found.`,
        );

        await this.store.setAMBProof(destinationChainId, ambProof);
    }
}

void new WormholeEngineWorker().run();
