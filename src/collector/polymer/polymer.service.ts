import pino from 'pino';
import { tryErrorToString, wait } from 'src/common/utils';
import { IbcEventEmitter__factory } from 'src/contracts';
import { Store } from 'src/store/store.lib';
import { AmbMessage } from 'src/store/types/store.types';
import { workerData } from 'worker_threads';
import { PolymerWorkerData } from './polymer';
import { AbiCoder, JsonRpcProvider } from 'ethers6';

const abi = AbiCoder.defaultAbiCoder();

/**
 * Example AMB implementation which uses a simple signed message to validate transactions.
 * A worker service is provided with the following parameters:
 * @dev You can also provide additional data here for your AMB. For example,
 * For future relayers, please update config.example.yaml with any values they might find useful.
 * @param workerData.chainId The id of the chain the worker runs for.
 * @param workerData.rpc The RPC to use for the chain.
 * @param workerData.incentivesAddress The address of the Generalised Incentive implementation for the AMB.
 * @param workerData.interval Interval of when to scan a bounty
 * @param workerData.maxBlocks Max number of blocks to scan at a time
 * @param workerData.blockDelay Some RPCs struggle to index events/logs for very recent transactions. As a result, there are some advantages to running slighly behind. If this is set, look at events which are .blockDelay behind the latest.
 * @param workerData.loggerOptions Logging relatied config to swap a pino logger with.
 */
const bootstrap = async () => {
  // Load all of the config into transparent variables.
  const config: PolymerWorkerData = workerData as PolymerWorkerData;
  const chainId = config.chainId;

  // Get a connection to the redis store.
  const store = new Store(chainId);

  // Start a logger. The provided logger options should be used.
  const logger = pino(config.loggerOptions).child({
    worker: 'collector-polymer',
    chain: chainId,
  });

  // It is good to give a warning that we are starting the collector service along with
  // some context regarding the execution.
  logger.info(
    { incentivesAddress: config.incentivesAddress },
    `Starting polymer service.`,
  );

  // Get an Ethers provider for us to collect bounties with.
  const provider = new JsonRpcProvider(config.rpc, undefined, {
    staticNetwork: true,
  });

  // Set the contract which we will receive messages through.
  const contract = IbcEventEmitter__factory.connect(
    config.polymerAddress,
    provider,
  );

  // In case this worker crashes (say bad RPC), the worker will be restarted.
  // If the error is indeed from the RPC, it is better to wait a bit before calling the RPC again.
  await wait(config.interval);

  let startBlock =
    config.startingBlock ??
    (await provider.getBlockNumber()) - config.blockDelay;

  // The stopping block is used if the relayer is only running for a fixed amount of time.
  const stopBlock = config.stoppingBlock ?? Infinity;

  // Main worker loop.
  while (true) {
    let endBlock: number;
    try {
      endBlock = (await provider.getBlockNumber()) - config.blockDelay;
    } catch (error) {
      logger.error(
        error,
        `Failed to get the current block on the 'polymer' collector service.`,
      );
      await wait(config.interval);
      continue;
    }

    // If there has been no new block, wait.
    if (startBlock > endBlock || !endBlock) {
      await wait(config.interval);
      continue;
    }

    // Used to stop the relayer after a certain block.
    if (endBlock > stopBlock) {
      endBlock = stopBlock;
    }

    // If the relayer was started in the pass, we can skip some parts of the logic for faster catching up.
    let isCatchingUp = false;
    const blocksToProcess = endBlock - startBlock;
    if (config.maxBlocks != null && blocksToProcess > config.maxBlocks) {
      endBlock = startBlock + config.maxBlocks;
      isCatchingUp = true;
    }

    logger.info(
      {
        startBlock,
        endBlock,
      },
      `Scanning polymer messages.`,
    );

    let messageLogs;
    try {
      // Get the Polymer message.
      messageLogs = await contract.queryFilter(
        contract.filters.SendPacket(),
        startBlock,
        endBlock,
      );
    } catch (error) {
      logger.error(
        {
          startBlock,
          endBlock,
          error: tryErrorToString(error),
        },
        `Failed to fetch logs.`,
      );
      await wait(config.interval);
      continue;
    }

    // If we found any, we should process them.
    if (messageLogs) {
      for (const messageEvent of messageLogs) {
        try {
          const destinationChain: string = messageEvent.args.sourceChannelId;
          // Decode the Universal channel payload

          const packet = messageEvent.args.packet.startsWith('0x')
            ? messageEvent.args.packet.slice(2)
            : messageEvent.args.packet;

          let params: [string, bigint, string, string];
          try {
            params = abi.decode(
              ['tuple(bytes32, uint256, bytes32, bytes)'],
              messageEvent.args.packet,
            )[0];
          } catch (error) {
            console.debug(
              `Couldn't decode a Polymer message. Likely because it is not a UniversalChannel Package ${error}`,
            );
            continue;
          }

          const incentivisedMessageEscrowFromPacket: string =
            '0x' + params[0].replaceAll('0x', '').slice(12 * 2);

          if (
            incentivisedMessageEscrowFromPacket.toLowerCase() !=
              config.incentivesAddress.toLowerCase() ||
            packet.length <= 384 + 64 * 2
          ) {
            continue;
          }

          // Derive the message identifier
          const amb: AmbMessage = {
            messageIdentifier:
              '0x' +
              params[3].replaceAll('0x', '').slice(1 * 2, 1 * 2 + 32 * 2),
            amb: 'polymer',
            sourceChain: chainId,
            destinationChain,
            payload: params[3],
          };

          // Set the collect message  on-chain. This is not the proof but the raw message.
          // It can be used by plugins to facilitate other jobs.
          await store.setAmb(amb, messageEvent.transactionHash);

          logger.info(
            {
              messageIdentifier: amb.messageIdentifier,
              destinationChainId: destinationChain,
            },
            `Polymer message found.`,
          );
        } catch (error) {
          logger.error(error, `Failed to process polymer message.`);
          await wait(config.interval);
        }
      }
    }

    if (endBlock >= stopBlock) {
      logger.info({ endBlock }, `Finished processing blocks. Exiting worker.`);
      break;
    }

    startBlock = endBlock + 1;
    if (!isCatchingUp) await wait(config.interval);
  }

  // Cleanup worker
  await store.quit();
};

void bootstrap();
