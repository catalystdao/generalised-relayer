import { StaticJsonRpcProvider } from '@ethersproject/providers';
import pino from 'pino';
import {
  IWormhole__factory,
  IncentivizedMessageEscrow__factory,
} from 'src/contracts';
import { Store } from 'src/store/store.lib';
import { workerData } from 'worker_threads';
import { wait } from '../../common/utils';
import { decodeWormholeMessage } from './wormhole.utils';
import { ParsePayload } from 'src/payload/decode.payload';
import { defaultAbiCoder } from '@ethersproject/abi';
import { WormholeMessageSnifferWorkerData } from './wormhole';

const bootstrap = async () => {
  const config = workerData as WormholeMessageSnifferWorkerData;
  const chainId = config.chainId;

  const store = new Store(chainId);
  const provider = new StaticJsonRpcProvider(config.rpc);

  const logger = pino(config.loggerOptions).child({
    worker: 'collector-wormhole',
    chain: chainId,
  });

  logger.info(
    { wormholeAddress: config.wormholeAddress },
    `Wormhole worker started.`,
  );

  let startBlock = config.startingBlock ?? (await provider.getBlockNumber());
  await wait(config.interval);

  const contract = IWormhole__factory.connect(config.wormholeAddress, provider);
  const messageEscrow = IncentivizedMessageEscrow__factory.connect(
    config.incentivesAddress,
    provider,
  );
  while (true) {
    let endBlock: number;
    try {
      endBlock = await provider.getBlockNumber();
    } catch (error) {
      logger.error(
        error,
        `Failed to get the current block number on the Wormhole collector service.`,
      );
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
      {
        startBlock,
        endBlock,
      },
      `Scanning wormhole messages.`,
    );

    try {
      const logs = await contract.queryFilter(
        contract.filters.LogMessagePublished(config.incentivesAddress),
        startBlock,
        endBlock,
      );

      for (const event of logs) {
        const payload = event.args.payload;
        const decodedWormholeMessage = decodeWormholeMessage(payload);

        const destinationChain =
          decodedWormholeMessage.destinationWormholeChainId.toString();

        logger.info(
          { messageIdentifier: decodedWormholeMessage.messageIdentifier },
          `Collected message.`,
        );
        await store.setAmb(
          {
            messageIdentifier: decodedWormholeMessage.messageIdentifier,
            amb: 'wormhole',
            sourceChain: chainId,
            destinationChain,
            payload: decodedWormholeMessage.payload,
            recoveryContext: event.args.sequence.toString(),
          },
          event.transactionHash,
        );

        // Decode payload
        const decodedPayload = ParsePayload(decodedWormholeMessage.payload);
        if (decodedPayload === undefined) {
          logger.info('Could not decode payload.');
          continue;
        }

        // Set destination address for the bounty.
        await store.registerDestinationAddress({
          messageIdentifier: decodedWormholeMessage.messageIdentifier,
          destinationAddress: await messageEscrow.implementationAddress(
            decodedPayload?.sourceApplicationAddress,
            defaultAbiCoder.encode(['uint256'], [destinationChain]),
          ),
        });
      }

      startBlock = endBlock + 1;
      await wait(config.interval);
    } catch (error) {
      logger.error(error, `Error on wormhole.service`);
      await wait(config.interval);
    }
  }
};

void bootstrap();
