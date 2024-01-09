import { StaticJsonRpcProvider } from '@ethersproject/providers';
import pino from 'pino';
import { ChainConfig } from 'src/config/config.service';
import { IWormhole__factory } from 'src/contracts';
import { Store } from 'src/store/store.lib';
import { workerData } from 'worker_threads';
import { wait } from '../../common/utils';
import { decodeWormholeMessage } from './wormhole.utils';

// TODO the following features must be implemented for the wormhole collector/engine:
// - startingBlock
// - stoppingBlock
// - blockDelay (is this desired?)
// The implementation of the above can be easily carried over from the 'mock' collector service,
// but it has not been done until the features are implemented on the 'wormhole-engine' service.

const bootstrap = async () => {
  const interval = workerData.interval;
  const maxBlocks = workerData.maxBlocks;
  const incentivesAddress = workerData.incentivesAddress;
  const wormholeAddress = workerData.wormholeAddress;
  const chainConfig: ChainConfig = workerData.chainConfig;
  const store = new Store(chainConfig.chainId);
  const provider = new StaticJsonRpcProvider(chainConfig.rpc);

  const logger = pino(workerData.loggerOptions).child({
    worker: 'collector-wormhole',
    chain: chainConfig.chainId,
  });

  logger.info(
    `Wormhole worker started (collecting published wormhole messages for bridge ${wormholeAddress} on ${chainConfig.name})`,
  );

  let startBlock =
    chainConfig.startingBlock ?? (await provider.getBlockNumber());
  await wait(interval);

  const contract = IWormhole__factory.connect(wormholeAddress, provider);
  while (true) {
    let endBlock: number;
    try {
      endBlock = await provider.getBlockNumber();
    } catch (error) {
      logger.error(error, `Failed on wormhole.service endblock`);
      await wait(interval);
      continue;
    }

    if (startBlock > endBlock || !endBlock) {
      await wait(interval);
      continue;
    }

    const blocksToProcess = endBlock - startBlock;
    if (blocksToProcess > maxBlocks) {
      endBlock = startBlock + maxBlocks;
    }

    logger.info(
      `Scanning wormhole messages from block ${startBlock} to ${endBlock} on ${chainConfig.name} Chain`,
    );

    try {
      const logs = await contract.queryFilter(
        contract.filters.LogMessagePublished(incentivesAddress),
        startBlock,
        endBlock,
      );

      for (const event of logs) {
        const payload = event.args.payload;
        const amb = decodeWormholeMessage(payload);
        logger.info(`Collected message ${amb.messageIdentifier}`);
        store.setAmb({
          ...amb,
          recoveryContext: event.args.sequence.toString(),
        });
      }

      startBlock = endBlock + 1;
      await wait(interval);
    } catch (error) {
      logger.error(error, `Failed on wormhole.service`);
      await wait(interval);
    }
  }
};

bootstrap();
