import {
  Environment,
  StandardRelayerApp,
  StandardRelayerContext,
} from '@wormhole-foundation/relayer-engine';
import { decodeWormholeMessage } from 'src/collector/wormhole/wormhole.utils';
import { add0X } from 'src/common/utils';
import { workerData } from 'worker_threads';
import { Store } from 'src/store/store.lib';
import { AmbPayload } from 'src/store/types/store.types';
import pino from 'pino';
import { WormholeRelayerEngineWorkerData } from './wormhole';

// TODO the following features must be implemented for the wormhole collector/engine:
// - startingBlock
// - stoppingBlock
// - blockDelay (is this desired?)

const bootstrap = async () => {
  const config = workerData as WormholeRelayerEngineWorkerData;

  const store = new Store(); // Read only stores can still publish messages.
  const enviroment = config.isTestnet
    ? Environment.TESTNET
    : Environment.MAINNET;
  const useDocker = config.useDocker;
  const spyPort = config.spyPort;

  const logger = pino(config.loggerOptions).child({
    worker: 'collector-wormhole-engine',
  });

  const wormholeChainConfig: Map<string, any> = config.wormholeChainConfig;
  const reverseWormholeChainConfig: Map<string, any> =
    config.reverseWormholeChainConfig;

  if (wormholeChainConfig.size == 0) {
    throw Error(
      'Unable to start the Wormhole Engine service: no chains specified.',
    );
  }

  // Starting sequence is used for debugging purposes.
  // If provided, it will try to do a better job of discovering vaas. If not set, I have no
  // idea what it does but I don't think it does any kind of searching.
  // For development:
  // 1. Ensure the spy is running
  // 2. Emit a wormhole message
  // 3. Get the sequence from the wormhole event. (manually, get the txid and to go explorer)
  // 4. Set the sequence-1 manually here and uncomment the relevant code.
  // 5. Wait 15 minutes.
  // const startingSequenceConfig: Record<number, bigint> = {};
  // wormholeChainConfig.forEach(
  //   (wormholeConfig) =>
  //     (startingSequenceConfig[wormholeConfig.wormholeChainId] = BigInt(0)),
  // );

  const namespace = 'wormhole relayer';
  const app = new StandardRelayerApp<StandardRelayerContext>(enviroment, {
    name: namespace,
    // missedVaaOptions: {
    //   startingSequenceConfig,
    //   forceSeenKeysReindex: true, // Make the search aggressive.
    // },
    redis: useDocker
      ? {
          host: 'redis',
        }
      : undefined,
    spyEndpoint: `${useDocker ? 'spy' : 'localhost'}:${spyPort}`,
    concurrency: wormholeChainConfig.size,
  });

  const incentivesAddresses: Record<number, string> = {};
  wormholeChainConfig.forEach(
    (wormholeConfig) =>
      (incentivesAddresses[wormholeConfig.wormholeChainId] =
        wormholeConfig.incentivesAddress),
  );
  //Listening to multiple chains for messages
  app.multiple(incentivesAddresses, async (ctx) => {
    const vaa = ctx.vaa!;

    const wormholeInfo = decodeWormholeMessage(
      add0X(vaa.payload.toString('hex')),
    );

    const destinationChain = reverseWormholeChainConfig.get(
      String(wormholeInfo.destinationChain),
    );

    const ambPayload: AmbPayload = {
      messageIdentifier: wormholeInfo.messageIdentifier,
      amb: 'wormhole',
      destinationChainId: destinationChain,
      message: add0X(vaa.bytes.toString('hex')),
      messageCtx: '0x',
    };
    logger.warn(
      `Got wormhole vaa ${vaa.sequence}, emitting to ${destinationChain}`,
    );
    await store.submitProof(destinationChain, ambPayload);
  });

  await app.listen();
};

void bootstrap();
