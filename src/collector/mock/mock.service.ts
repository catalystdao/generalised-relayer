import { StaticJsonRpcProvider } from '@ethersproject/providers';
import { Wallet, ethers } from 'ethers';
import { keccak256 } from 'ethers/lib/utils';
import pino from 'pino';
import { convertHexToDecimal, wait } from 'src/common/utils';
import { IncentivizedMockEscrow__factory } from 'src/contracts';
import { Store } from 'src/store/store.lib';
import { AmbPayload } from 'src/store/types/store.types';
import { workerData } from 'worker_threads';
import {
  decodeMockMessage,
  encodeMessage,
  encodeSignature,
} from './mock.utils';
import { MockWorkerData } from './mock';

/**
 * Example AMB implementation which uses a simple signed message to validate transactions.
 * A worker service is provided with the following parameters:
 * @dev You can also provide additional data here for your AMB. For example,
 * Mock gets the additional parameter: workerData.mockPrivateKey. Simply set it in the coonfig.
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
  const config: MockWorkerData = workerData as MockWorkerData;
  const chainId = config.chainId;

  // Get a connection to the redis store.
  // We have wrapped the redis store into a lib to make it easier to standardise
  // communication between the various components.
  const store = new Store(chainId);

  // Start a logger. The provided logger options should be used.
  // For the worker name, use the AMB's name and include the service.
  // If the AMB require multiple worker for different parts of the relaying job,
  // then use collector-<AMB> as the bounty worker and collector-<OTHER JOBS>-<AMB>
  // for the other job(s).
  // In our case, Mock only needs one which is appropiately named 'collector-mock'.
  const logger = pino(config.loggerOptions).child({
    worker: 'collector-mock',
    chain: chainId,
  });

  // It is good to give a warning that we are starting the collector service along with
  // some context regarding the execution.
  logger.info(
    `Starting mock for contract ${config.incentivesAddress} on chain ${chainId}`,
  );

  // Get an Ethers provider for us to collect bounties with.
  const provider = new StaticJsonRpcProvider(config.rpc);

  // Create a signing key using the provided AMB config:
  const signingKey = new Wallet(config.privateKey, provider)._signingKey();

  // Set the contract which we will receive messages through.
  const contract = IncentivizedMockEscrow__factory.connect(
    config.incentivesAddress,
    provider,
  );
  const bytes32Address = ethers.utils.hexZeroPad(config.incentivesAddress, 32);

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
      logger.error(error, `Failed to get current block for chain ${chainId}`);
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
      `Scanning mock messages from block ${startBlock} to ${endBlock} on chain ${config.chainId}`,
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
        `Failed to fetch logs from block ${startBlock} to ${endBlock} on chain ${config.chainId}`,
      );
      await wait(config.interval);
      continue;
    }

    // If we found any, we should process them.
    if (messageLogs) {
      for (const messageEvent of messageLogs) {
        try {
          const message = messageEvent.args.message;

          // Derive the message identifier
          const amb = decodeMockMessage(message);

          // Set the collect message  on-chain. This is not the proof but the raw message.
          // It can be used by plugins to facilitate other jobs.
          await store.setAmb(amb, messageEvent.transactionHash);

          // Encode and sign the message for delivery.
          // This is the proof which enables us to submit the transaciton later.
          // For Mock, this is essentially PoA with a single key. The deployment needs to match the private key available
          // to the relayer.
          const encodedMessage = encodeMessage(bytes32Address, message);
          const signature = signingKey.signDigest(keccak256(encodedMessage));
          const executionContext = encodeSignature(signature);

          const destinationChainId = convertHexToDecimal(amb.destinationChain);

          // Construct the payload.
          const ambPayload: AmbPayload = {
            messageIdentifier: amb.messageIdentifier,
            amb: 'mock',
            destinationChainId,
            message: encodedMessage,
            messageCtx: executionContext, // If the generalised incentives implementation does not use the context set it to "0x".
          };

          logger.info(
            `Got mock message ${amb.messageIdentifier}, emitting to ${destinationChainId}`,
          );

          // Submit the proofs to any listeners. If there is a submitter, it will process the proof and submit it.
          await store.submitProof(destinationChainId, ambPayload);
        } catch (error) {
          logger.error(error, `Failed to process mock message`);
          await wait(config.interval);
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
    if (!isCatchingUp) await wait(config.interval);
  }

  // Cleanup worker
  await store.quit();
};

void bootstrap();
