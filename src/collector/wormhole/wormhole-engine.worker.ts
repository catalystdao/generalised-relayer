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
import { AmbPayload } from 'src/store/types/store.types';
import pino, { LoggerOptions } from 'pino';
import {
  WormholeChainConfig,
  WormholeChainId,
  WormholeRelayerEngineWorkerData,
} from './wormhole.types';

// NOTE: the Wormhole relayer engine is only able of scanning new VAAs. For old VAA recovery
// the 'wormhole-recovery' worker is used.

class WormholeEngineWorker {
  readonly config: WormholeRelayerEngineWorkerData;

  readonly logger: pino.Logger;
  readonly stores: Map<WormholeChainId, Store>;

  readonly engine: StandardRelayerApp<StandardRelayerContext>;

  constructor() {
    this.config = workerData as WormholeRelayerEngineWorkerData;

    this.logger = this.initializeLogger(this.config.loggerOptions);
    this.stores = this.loadStores(this.config.wormholeChainConfigs);

    this.engine = this.loadWormholeRelayerEngine();
  }

  // Initialization helpers
  // ********************************************************************************************

  private initializeLogger(loggerOptions: LoggerOptions): pino.Logger {
    return pino(loggerOptions).child({
      worker: 'collector-wormhole-engine',
    });
  }

  private loadStores(
    wormholeChainConfig: Map<string, WormholeChainConfig>,
  ): Map<WormholeChainId, Store> {
    const stores: Map<WormholeChainId, Store> = new Map();
    for (const [chainId, wormholeConfig] of wormholeChainConfig) {
      stores.set(wormholeConfig.wormholeChainId, new Store(chainId));
    }

    return stores;
  }

  private loadWormholeRelayerEngine(): StandardRelayerApp<StandardRelayerContext> {
    const namespace = 'wormhole relayer';
    const enviroment = this.config.isTestnet
      ? Environment.TESTNET
      : Environment.MAINNET;
    const useDocker = this.config.useDocker;
    const spyPort = this.config.spyPort;

    if (this.config.wormholeChainConfigs.size == 0) {
      throw new Error(
        'Unable to start the Wormhole Engine service: no chains specified.',
      );
    }
    const concurrency = this.config.wormholeChainConfigs.size;

    // Starting sequence is used for debugging purposes.
    // If provided, it will try to do a better job of discovering vaas. If not set, I have no
    // idea what it does but I don't think it does any kind of searching.
    // For development:
    // 1. Ensure the spy is running
    // 2. Emit a wormhole message
    // 3. Get the sequence from the wormhole event. (manually, get the txid and to go explorer)
    // 4. Set the sequence-1 manually here and uncomment the relevant code.
    // 5. Wait 15 minutes.
    const missedVaaOptions = undefined;
    // const startingSequenceConfig: Record<number, bigint> = {};
    // this.config.wormholeChainConfig.forEach(
    //   (wormholeConfig) =>
    //     (startingSequenceConfig[wormholeConfig.wormholeChainId] = BigInt(0)),
    // );
    // const missedVaaOptions = {
    //   startingSequenceConfig,
    //   forceSeenKeysReindex: true, // Make the search aggressive.
    // };

    const app = new StandardRelayerApp<StandardRelayerContext>(enviroment, {
      name: namespace,
      missedVaaOptions,
      redis: useDocker
        ? {
            host: 'redis',
          }
        : undefined,
      spyEndpoint: `${useDocker ? 'spy' : 'localhost'}:${spyPort}`,
      concurrency,
    });

    return app;
  }

  // Main handler
  // ********************************************************************************************
  async run(): Promise<void> {
    //Listening to multiple chains for messages
    const chainsAndAddresses = this.getChainsAndAddresses();
    this.engine.multiple(chainsAndAddresses, async (ctx) => {
      if (ctx.vaa != undefined) {
        await this.processVAA(ctx.vaa!);
      }
    });

    await this.engine.listen();
  }

  // Helpers
  // ********************************************************************************************
  private getChainsAndAddresses(): Record<WormholeChainId, string | string[]> {
    const chainsAndAddresses: Record<number, string | string[]> = {};
    this.config.wormholeChainConfigs.forEach(
      (wormholeConfig) =>
        (chainsAndAddresses[wormholeConfig.wormholeChainId] =
          wormholeConfig.incentivesAddress),
    );
    return chainsAndAddresses;
  }

  private async processVAA(vaa: ParsedVaaWithBytes): Promise<void> {
    const wormholeInfo = decodeWormholeMessage(
      add0X(vaa.payload.toString('hex')),
    );

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

    const ambPayload: AmbPayload = {
      messageIdentifier: wormholeInfo.messageIdentifier,
      amb: 'wormhole',
      destinationChainId,
      message: add0X(vaa.bytes.toString('hex')),
      messageCtx: '0x',
    };

    this.logger.info(
      { sequence: vaa.sequence, destinationChainId },
      `Wormhole VAA found.`,
    );

    const store = this.stores.get(vaa.emitterChain);
    if (store != undefined) {
      await store.submitProof(destinationChainId, ambPayload);
    } else {
      this.logger.warn(
        {
          wormholeVAAEmitterChain: vaa.emitterChain,
        },
        `No 'Store' found for the Wormhole VAA emitter chain id.`,
      );
    }
  }
}

void new WormholeEngineWorker().run();
