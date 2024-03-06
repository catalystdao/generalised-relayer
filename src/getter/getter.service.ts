import { wait } from 'src/common/utils';
import pino from 'pino';
import { workerData } from 'worker_threads';
import { utils } from 'ethers';
import { FormatTypes, LogDescription } from '@ethersproject/abi';
import {
  BaseProvider,
  Log,
  StaticJsonRpcProvider,
} from '@ethersproject/providers';
import { IMessageEscrowEvents__factory } from 'src/contracts';
import { Store } from 'src/store/store.lib';
import { GetterWorkerData } from './getter.controller';

const GET_LOGS_RETRY_INTERVAL = 2000;

/**
 * Collection bounty logs every fixed interval to find new bounties being placed and old bouinties that got relayed
 * @param workerData.chain The chain to scan bounties from
 * @param workerData.interval Interval of when to scan a bounty
 */
const bootstrap = async () => {
  const config = workerData as GetterWorkerData;

  const chainId = config.chainId;
  const store = new Store(chainId);

  const logger = pino(workerData.loggerOptions).child({
    worker: 'getter',
    chain: chainId,
  });

  const provider = new StaticJsonRpcProvider(config.rpc);

  const incentivesContractInterface =
    IMessageEscrowEvents__factory.createInterface();

  const topics = [
    [
      utils.id(
        incentivesContractInterface
          .getEvent('BountyPlaced')
          .format(FormatTypes.sighash),
      ),
      utils.id(
        incentivesContractInterface
          .getEvent('BountyClaimed')
          .format(FormatTypes.sighash),
      ),
      utils.id(
        incentivesContractInterface
          .getEvent('MessageDelivered')
          .format(FormatTypes.sighash),
      ),
      utils.id(
        incentivesContractInterface
          .getEvent('BountyIncreased')
          .format(FormatTypes.sighash),
      ),
    ],
  ];

  logger.info(
    {
      incentiveAddresses: config.incentivesAddresses,
    },
    `Getter worker started.`,
  );

  let startBlock =
    config.startingBlock ??
    (await provider.getBlockNumber()) - config.blockDelay;

  const stopBlock = config.stoppingBlock ?? Infinity;

  await wait(config.interval);

  while (true) {
    let endBlock: number;
    try {
      endBlock = (await provider.getBlockNumber()) - config.blockDelay;
    } catch (error) {
      logger.error(
        error,
        `Failed to get the current block number on the getter.`,
      );
      await wait(config.interval);
      continue;
    }

    if (startBlock > endBlock || !endBlock) {
      await wait(config.interval);
      continue;
    }

    if (endBlock > stopBlock) {
      endBlock = stopBlock;
    }

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
      `Scanning bounties.`,
    );

    try {
      //Query all bounty events
      const logs = await queryAllBountyEvents(
        provider,
        config.incentivesAddresses,
        topics,
        startBlock,
        endBlock,
        logger,
      );

      for (const log of logs) {
        const parsedLog = {
          ...incentivesContractInterface.parseLog(log),
          transactionHash: log.transactionHash,
        };

        if (parsedLog == null) {
          logger.error(
            { topics: log.topics, data: log.data },
            `Failed to parse GeneralisedIncentives contract event.`,
          );
          continue;
        }

        switch (parsedLog.name) {
          case 'BountyPlaced':
            await handleBountyPlacedEvent(
              log.address,
              parsedLog,
              store,
              logger,
            );
            break;

          case 'BountyClaimed':
            await handleBountyClaimedEvent(
              log.address,
              parsedLog,
              store,
              logger,
            );
            break;

          case 'MessageDelivered':
            await handleMessageDeliveredEvent(
              log.address,
              parsedLog,
              store,
              logger,
            );
            break;

          case 'BountyIncreased':
            await handleBountyIncreasedEvent(
              log.address,
              parsedLog,
              store,
              logger,
            );
            break;

          default:
            logger.warn(
              { name: parsedLog.name, topic: parsedLog.topic },
              `Event with unknown name/topic received.`,
            );
        }
      }

      if (endBlock >= stopBlock) {
        logger.info(
          { endBlock },
          `Finished processing blocks. Exiting worker.`,
        );
        break;
      }

      startBlock = endBlock + 1;
      if (!isCatchingUp) await wait(config.interval);
    } catch (error) {
      logger.error(error, `Error on getter.service`);
      await wait(config.interval);
    }
  }

  // Cleanup worker
  await store.quit();
};

const queryAllBountyEvents = async (
  provider: BaseProvider,
  incentivesAddresses: string[],
  topics: string[][],
  startBlock: number,
  endBlock: number,
  logger: pino.Logger,
): Promise<Log[]> => {
  //TODO fix: use a single rpc call once ethers is upgraded to v6

  const logs: Log[] = [];
  for (const address of incentivesAddresses) {
    let i = 0;
    while (true) {
      try {
        const addressLogs = await provider.getLogs({
          address: address,
          topics,
          fromBlock: startBlock,
          toBlock: endBlock,
        });
        logs.push(...addressLogs);

        break;
      } catch (error) {
        i++;
        logger.warn(
          { address, startBlock, endBlock, error, try: i },
          `Failed to 'getLogs' on getter.`,
        );
        await new Promise((r) => setTimeout(r, GET_LOGS_RETRY_INTERVAL));
      }
    }
  }

  return logs;
};

//TODO doc
/**
 * Tracking BountyPlaced logs and updating the bounties map when new ones are being found
 * @param contract //Bounty Contract
 * @param address //Bounty Contract address
 * @param chain //Chain bounty was found on
 */
const handleBountyPlacedEvent = async (
  incentivesAddress: string,
  event: LogDescription & { transactionHash: string },
  store: Store,
  logger: pino.Logger,
) => {
  const messageIdentifier = event.args.messageIdentifier;
  const incentive = event.args.incentive;

  logger.info({ messageIdentifier }, `BountyPlaced event found.`);

  await store.registerBountyPlaced({
    messageIdentifier,
    incentive,
    incentivesAddress,
    transactionHash: event.transactionHash,
  });
};

//TODO doc
/**
 * Tracking BountyClaimed logs and removing bounty from the bounties map when fired
 * @param contract //Bounty Contract
 * @param address //Bounty Contract address
 * @param chain //Chain bounty was found on
 */
const handleBountyClaimedEvent = async (
  incentivesAddress: string,
  event: LogDescription & { transactionHash: string },
  store: Store,
  logger: pino.Logger,
) => {
  const messageIdentifier = event.args.uniqueIdentifier;

  logger.info({ messageIdentifier }, `BountyClaimed event found.`);

  await store.registerBountyClaimed({
    messageIdentifier,
    incentivesAddress,
    transactionHash: event.transactionHash,
  });
};

//TODO doc
/**
 * Tracking MessageDelivered logs and updating the specific bounty using the messageIdentifier
 * @param contract //Bounty Contract
 * @param address //Bounty Contract address
 * @param chain //Chain bounty was found on
 */
const handleMessageDeliveredEvent = async (
  incentivesAddress: string,
  event: LogDescription & { transactionHash: string },
  store: Store,
  logger: pino.Logger,
) => {
  const messageIdentifier = event.args.messageIdentifier;

  logger.info({ messageIdentifier }, `MessageDelivered event found.`);

  await store.registerMessageDelivered({
    messageIdentifier,
    incentivesAddress,
    transactionHash: event.transactionHash,
  });
};

//TODO doc
/**
 * Tracking BountyIncreased logs and updating the specific bounty using the messageIdentifier
 * @param contract //Bounty Contract
 * @param address //Bounty Contract address
 * @param chain //Chain bounty was found on
 */
const handleBountyIncreasedEvent = async (
  incentivesAddress: string,
  event: LogDescription & { transactionHash: string },
  store: Store,
  logger: pino.Logger,
) => {
  const messageIdentifier = event.args.messageIdentifier;
  // TODO: Fix naming of args.
  const newDeliveryGasPrice = event.args.deliveryGasPriceIncrease;
  const newAckGasPrice = event.args.ackGasPriceIncrease;

  logger.info({ messageIdentifier }, `BountyIncreased event found.`);

  await store.registerBountyIncreased({
    messageIdentifier,
    newDeliveryGasPrice,
    newAckGasPrice,
    incentivesAddress,
    transactionHash: event.transactionHash,
  });
};

void bootstrap();
