import { wait } from 'src/common/utils';
import pino from 'pino';
import { workerData } from 'worker_threads';
import { ChainConfig } from 'src/config/config.service';
import { utils } from 'ethers';
import { FormatTypes, LogDescription } from '@ethersproject/abi';
import {
  BaseProvider,
  Log,
  StaticJsonRpcProvider,
} from '@ethersproject/providers';
import { IMessageEscrowEvents__factory } from 'src/contracts';
import { Store } from 'src/store/store.lib';

const GET_LOGS_RETRY_INTERVAL = 2000;

/**
 * Collection bounty logs every fixed interval to find new bounties being placed and old bouinties that got relayed
 * @param workerData.chain The chain to scan bounties from
 * @param workerData.interval Interval of when to scan a bounty
 */
const bootstrap = async () => {
  const interval = workerData.interval;
  const maxBlocks = workerData.maxBlocks;
  const chainConfig: ChainConfig = workerData.chainConfig;
  const store = new Store(chainConfig.chainId);
  const incentivesAddresses: string[] = workerData.incentivesAddresses;
  const blockDelay = workerData.blockDelay ?? 0;

  const logger = pino(workerData.loggerOptions).child({
    worker: 'getter',
    chain: chainConfig.chainId,
  });

  const provider = new StaticJsonRpcProvider(chainConfig.rpc);

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
    `Getter worker started (collecting escrowed messages of address(es) ${incentivesAddresses.join(
      ', ',
    )} on ${chainConfig.name})`,
  );

  let startBlock =
    chainConfig.startingBlock ?? (await provider.getBlockNumber()) - blockDelay;

  const stopBlock = chainConfig.stoppingBlock ?? Infinity;

  await wait(interval);

  while (true) {
    let endBlock: number;
    try {
      endBlock = (await provider.getBlockNumber()) - blockDelay;
    } catch (error) {
      logger.error(error, `Failed on getter.service endblock`);
      await wait(interval);
      continue;
    }

    if (startBlock > endBlock || !endBlock) {
      await wait(interval);
      continue;
    }

    if (endBlock > stopBlock) {
      endBlock = stopBlock;
    }

    let isCatchingUp = false;
    const blocksToProcess = endBlock - startBlock;
    if (blocksToProcess > maxBlocks) {
      endBlock = startBlock + maxBlocks;
      isCatchingUp = true;
    }

    logger.info(
      `Scanning bounties from block ${startBlock} to ${endBlock} on ${chainConfig.name} Chain`,
    );

    try {
      //Query all bounty events
      const logs = await queryAllBountyEvents(
        provider,
        incentivesAddresses,
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
            `Failed to parse GeneralisedIncentives contract event. Topics: ${log.topics}, data: ${log.data}`,
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
              `Event with unknown name/topic received: ${parsedLog.name}/${parsedLog.topic}`,
            );
        }
      }

      if (endBlock >= stopBlock) {
        logger.info(
          `Finished processing blocks (stopping at ${endBlock}). Exiting worker.`,
        );
        break;
      }

      startBlock = endBlock + 1;
      if (!isCatchingUp) await wait(interval);
    } catch (error) {
      logger.error(error, `Failed on getter.service`);
      await wait(interval);
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
          `Failed to 'getLogs' for address ${address} from ${startBlock} to ${endBlock} (try ${i}).`,
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

  logger.info(`BountyPlaced ${messageIdentifier}`);

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

  logger.info(`BountyClaimed ${messageIdentifier}`);

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

  logger.info(`MessageDelivered ${messageIdentifier}`);

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

  logger.info(`BountyIncreased ${messageIdentifier}`);

  await store.registerBountyIncreased({
    messageIdentifier,
    newDeliveryGasPrice,
    newAckGasPrice,
    incentivesAddress,
    transactionHash: event.transactionHash,
  });
};

bootstrap();
