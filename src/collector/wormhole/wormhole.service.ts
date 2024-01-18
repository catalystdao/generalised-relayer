import { StaticJsonRpcProvider } from '@ethersproject/providers';
import pino from 'pino';
import { IWormhole__factory } from 'src/contracts';
import { Store } from 'src/store/store.lib';
import { workerData } from 'worker_threads';
import { wait } from '../../common/utils';
import { decodeWormholeMessage } from './wormhole.utils';
import { WormholePacketSnifferWorkerData } from './wormhole';

// TODO the following features must be implemented for the wormhole collector/engine:
// - startingBlock
// - stoppingBlock
// - blockDelay (is this desired?)
// The implementation of the above can be easily carried over from the 'mock' collector service,
// but it has not been done until the features are implemented on the 'wormhole-engine' service.

const bootstrap = async () => {
  const config = workerData as WormholePacketSnifferWorkerData;
  const chainId = config.chainId;

  const store = new Store(chainId);
  const provider = new StaticJsonRpcProvider(config.rpc);

  const logger = pino(config.loggerOptions).child({
    worker: 'collector-wormhole',
    chain: chainId,
  });

  logger.info(
    `Wormhole worker started (collecting published wormhole messages for bridge ${config.wormholeAddress} on chain ${chainId})`,
  );

  let startBlock = config.startingBlock ?? (await provider.getBlockNumber());
  await wait(config.interval);

  const contract = IWormhole__factory.connect(config.wormholeAddress, provider);
  while (true) {
    let endBlock: number;
    try {
      endBlock = await provider.getBlockNumber();
    } catch (error) {
      logger.error(error, `Failed on wormhole.service endblock`);
      await wait(config.interval);
      continue;
    }

    if (startBlock > endBlock || !endBlock) {
      await wait(config.interval);
      continue;
    }

    const blocksToProcess = endBlock - startBlock;
    if (config.maxBlocks != null && blocksToProcess > config.maxBlocks) {
      endBlock = startBlock + config.maxBlocks;
    }

    logger.info(
      `Scanning wormhole messages from block ${startBlock} to ${endBlock} on chain ${config.chainId}`,
    );

    try {
      const logs = await contract.queryFilter(
        contract.filters.LogMessagePublished(config.incentivesAddress),
        startBlock,
        endBlock,
      );

      for (const event of logs) {
        const payload = event.args.payload;
        const amb = decodeWormholeMessage(payload);
        logger.info(`Collected message ${amb.messageIdentifier}`);
        store.setAmb(
          {
            ...amb,
            sourceChain: chainId,
            recoveryContext: event.args.sequence.toString(),
          },
          event.transactionHash,
        );
      }

      startBlock = endBlock + 1;
      await wait(config.interval);
    } catch (error) {
      logger.error(error, `Failed on wormhole.service`);
      await wait(config.interval);
    }
  }
};

bootstrap();
