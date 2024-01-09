import { StaticJsonRpcProvider } from '@ethersproject/providers';
import { Wallet, ethers } from 'ethers';
import { keccak256 } from 'ethers/lib/utils';
import pino from 'pino';
import { convertHexToDecimal, wait } from 'src/common/utils';
import { ChainConfig } from 'src/config/config.service';
import { IncentivizedMockEscrow__factory } from 'src/contracts';
import { Store } from 'src/store/store.lib';
import { AmbPayload } from 'src/store/types/store.types';
import { workerData } from 'worker_threads';
import {
  decodeMockMessage,
  encodeMessage,
  encodeSignature,
} from './mock.utils';

/**
 * Example AMB implementation which uses a simple signed message to validate transactions.
 * A worker service is provided with the following parameters:
 * @dev You can also provide additional data here for your AMB. For example,
 * Mock gets the additional parameter: workerData.mockPrivateKey. Simply set it in the coonfig.
 * For future relayers, please update config.example.yaml with any values they might find useful.
 * @param workerData.chainConfig The associated config for the chain which the worker runs on.
 * @param workerData.incentivesAddress The address of the Generalised Incentive implementation for the AMB.
 * @param workerData.interval Interval of when to scan a bounty
 * @param workerData.maxBlocks Max number of blocks to scan at a time
 * @param workerData.blockDelay Some RPCs struggle to index events/logs for very recent transactions. As a result, there are some advantages to running slighly behind. If this is set, look at events which are .blockDelay behind the latest.
 * @param workerData.loggerOptions Logging relatied config to swap a pino logger with.
 */
const bootstrap = async () => {
  // Load all of the config into transparent variables.
  const chainConfig: ChainConfig = workerData.chainConfig;
  const incentivesAddress = workerData.incentivesAddress;
  const interval = workerData.interval;
  const maxBlocks = workerData.maxBlocks;
  const blockDelay = workerData.blockDelay ?? 0;

  // Get a connection to the redis store.
  // We have wrapped the redis store into a lib to make it easier to standardise
  // communication between the various components.
  const store = new Store(chainConfig.chainId);

  // Start a logger. The provided logger options should be used.
  // For the worker name, use the AMB's name and include the service.
  // If the AMB require multiple worker for different parts of the relaying job,
  // then use collector-<AMB> as the bounty worker and collector-<OTHER JOBS>-<AMB>
  // for the other job(s).
  // In our case, Mock only needs one which is appropiately named 'collector-mock'.
  const logger = pino(workerData.loggerOptions).child({
    worker: 'collector-mock',
    chain: chainConfig.chainId,
  });

  // It is good to give a warning that we are starting the collector service along with
  // some context regarding the execution.
  logger.info(
    `Starting mock for contract ${incentivesAddress} on ${chainConfig.name}`,
  );

  // Get an Ethers provider for us to collect bounties with.
  const provider = new StaticJsonRpcProvider(chainConfig.rpc);

  // Create a signing key using the provided AMB config:
  const signingKey = new Wallet(
    workerData.mockPrivateKey,
    provider,
  )._signingKey();

  // Set the contract which we will receive messages through.
  const contract = IncentivizedMockEscrow__factory.connect(
    incentivesAddress,
    provider,
  );
  const bytes32Address = ethers.utils.hexZeroPad(incentivesAddress, 32);

  // In case this worker crashes (say bad RPC), the worker will be restarted.
  // If the error is indeed from the RPC, it is better to wait a bit before calling the RPC again.
  await wait(interval);

  let startBlock =
    chainConfig.startingBlock ?? (await provider.getBlockNumber()) - blockDelay;

  // The stopping block is used if the relayer is only running for a fixed amount of time.
  const stopBlock = chainConfig.stoppingBlock ?? Infinity;

  // Main worker loop.
  while (true) {
    let endBlock: number;
    try {
      endBlock = (await provider.getBlockNumber()) - blockDelay;
    } catch (error) {
      logger.error(error, `Failed to get current block, ${chainConfig.name}`);
      await wait(interval);
      continue;
    }

    // If there has been no new block, wait.
    if (startBlock > endBlock || !endBlock) {
      await wait(interval);
      continue;
    }

    // Used to stop the relayer after a certain block.
    if (endBlock > stopBlock) {
      endBlock = stopBlock;
    }

    // If the relayer was started in the pass, we can skip some parts of the logic for faster catching up.
    let isCatchingUp = false;
    const blocksToProcess = endBlock - startBlock;
    if (blocksToProcess > maxBlocks) {
      endBlock = startBlock + maxBlocks;
      isCatchingUp = true;
    }

    logger.info(
      `Scanning mock messages from block ${startBlock} to ${endBlock} on ${chainConfig.name}`,
    );

    let messageLogs;
    try {
      // Get the Mock message.
      messageLogs = await contract.queryFilter(
        contract.filters.Message(),
        startBlock,
        endBlock,
      );
    } catch (error) {
      logger.error(
        error,
        `Failed to fetch logs from block ${startBlock} to ${endBlock} on ${chainConfig.name}`,
      );
      await wait(interval);
      continue;
    }

    // If we found any, we should process them.
    if (messageLogs) {
      for (const messageEvent of messageLogs) {
        try {
          const message = messageEvent.args.message;

          // Derive the message identifier
          const amb = decodeMockMessage(message);

          // Encode and sign the message for delivery.
          // This is the proof which enables us to submit the transaciton later.
          // For Mock, this is essentially PoA with a single key. The deployment needs to match the private key available
          // to the relayer.
          const encodedMessage = encodeMessage(bytes32Address, message);
          const signature = signingKey.signDigest(keccak256(encodedMessage));
          const executionContext = encodeSignature(signature);

          // Get the channel so that we can the message can be evaluated and submitted.
          const emitToChannel = Store.getChannel(
            'submit',
            convertHexToDecimal(amb.destinationChain),
          );
          logger.info(
            `Collected message ${amb.messageIdentifier} to ${emitToChannel}`,
          );

          // Construct the payload.
          const ambPayload: AmbPayload = {
            messageIdentifier: amb.messageIdentifier,
            amb: 'mock',
            destinationChainId: convertHexToDecimal(amb.destinationChain),
            message: encodedMessage,
            messageCtx: executionContext, // If the generalised incentives implementation does not use the context set it to "0x".
          };

          // Set the proof into redis. (So we can work on it later.)
          store.setAmb(amb);

          // Submit the message to any listeners so that it can be promptly submitted.
          await store.postMessage(emitToChannel, ambPayload);
        } catch (error) {
          logger.error(error, `Failed to process mock message`);
          await wait(interval);
        }
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
  }

  // Cleanup worker
  await store.quit();
};

bootstrap();

// TODO: Fix
// const setAMBFromMessage = (payload: string, destinationChain: Chain) => {
//   const messageIdentifier = add0X(payload.substring(132, 198));
//   const amb: AMB = {
//     messageIdentifier,
//     destinationChain: destinationChain.chainId,
//     payload,
//   };
//   parentPort?.postMessage(amb);
// };
