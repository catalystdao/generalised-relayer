import { StaticJsonRpcProvider } from '@ethersproject/providers';
import pino, { LoggerOptions } from 'pino';
import {
  IWormhole,
  IWormhole__factory,
  IncentivizedMessageEscrow,
  IncentivizedMessageEscrow__factory,
} from 'src/contracts';
import { Store } from 'src/store/store.lib';
import { workerData } from 'worker_threads';
import { wait } from '../../common/utils';
import { decodeWormholeMessage } from './wormhole.utils';
import { ParsePayload } from 'src/payload/decode.payload';
import { defaultAbiCoder } from '@ethersproject/abi';
import { LogMessagePublishedEvent } from 'src/contracts/IWormhole';
import { WormholeMessageSnifferWorkerData } from './wormhole.types';

//TODO implement stopping block (see getter)

class WormholeMessageSnifferWorker {
  readonly store: Store;
  readonly logger: pino.Logger;

  readonly config: WormholeMessageSnifferWorkerData;

  readonly provider: StaticJsonRpcProvider;

  readonly chainId: string;

  readonly wormholeContract: IWormhole;
  readonly messageEscrowContract: IncentivizedMessageEscrow;

  constructor() {
    this.config = workerData as WormholeMessageSnifferWorkerData;

    this.chainId = this.config.chainId;

    this.store = new Store(this.chainId);
    this.logger = this.initializeLogger(
      this.chainId,
      this.config.loggerOptions,
    );
    this.provider = this.initializeProvider(this.config.rpc);

    this.wormholeContract = this.initializeWormholeContract(
      this.config.wormholeAddress,
      this.provider,
    );

    this.messageEscrowContract = this.initializeMessageEscrowContract(
      this.config.incentivesAddress,
      this.provider,
    );
  }

  // Initialization helpers
  // ********************************************************************************************

  private initializeLogger(
    chainId: string,
    loggerOptions: LoggerOptions,
  ): pino.Logger {
    return pino(loggerOptions).child({
      worker: 'collector-wormhole-message-sniffer',
      chain: chainId,
    });
  }

  private initializeProvider(rpc: string): StaticJsonRpcProvider {
    return new StaticJsonRpcProvider(rpc);
  }

  private initializeWormholeContract(
    wormholeAddress: string,
    provider: StaticJsonRpcProvider,
  ): IWormhole {
    return IWormhole__factory.connect(wormholeAddress, provider);
  }

  private initializeMessageEscrowContract(
    incentivesAddress: string,
    provider: StaticJsonRpcProvider,
  ): IncentivizedMessageEscrow {
    return IncentivizedMessageEscrow__factory.connect(
      incentivesAddress,
      provider,
    );
  }

  // Main handler
  // ********************************************************************************************
  async run(): Promise<void> {
    this.logger.info(
      { wormholeAddress: this.config.wormholeAddress },
      `Wormhole worker started.`,
    );

    let startBlock =
      this.config.startingBlock ?? (await this.provider.getBlockNumber());
    await wait(this.config.interval);

    while (true) {
      let endBlock: number;
      try {
        endBlock = await this.provider.getBlockNumber();
      } catch (error) {
        this.logger.error(
          error,
          `Failed to get the current block number on the Wormhole collector service.`,
        );
        await wait(this.config.interval);
        continue;
      }

      if (!endBlock || startBlock > endBlock) {
        await wait(this.config.interval);
        continue;
      }

      const blocksToProcess = endBlock - startBlock;
      if (
        this.config.maxBlocks != null &&
        blocksToProcess > this.config.maxBlocks
      ) {
        endBlock = startBlock + this.config.maxBlocks;
      }

      this.logger.info(
        {
          startBlock,
          endBlock,
        },
        `Scanning wormhole messages.`,
      );

      const logs = await this.queryLogs(startBlock, endBlock);

      for (const log of logs) {
        try {
          await this.handleLogMessagedPublishedEvent(log);
        } catch (error) {
          this.logger.error(
            { log, error },
            'Failed to process LogMessagePublishedEvent on Wormhole sniffer worker.',
          );
        }
      }

      startBlock = endBlock + 1;
      await wait(this.config.interval);
    }
  }

  private async queryLogs(
    fromBlock: number,
    toBlock: number,
  ): Promise<LogMessagePublishedEvent[]> {
    const filter = this.wormholeContract.filters.LogMessagePublished(
      this.config.incentivesAddress,
    );

    let logs: LogMessagePublishedEvent[] | undefined;
    let i = 0;
    while (logs == undefined) {
      try {
        logs = await this.wormholeContract.queryFilter(
          filter,
          fromBlock,
          toBlock,
        );
      } catch (error) {
        i++;
        this.logger.warn(
          { ...filter, error, try: i },
          `Failed to get 'LogMessagePublished' events on WormholeMessageSnifferWorker. Worker blocked until successful query.`,
        );
        await wait(this.config.interval);
      }
    }

    return logs;
  }

  private async handleLogMessagedPublishedEvent(
    log: LogMessagePublishedEvent,
  ): Promise<void> {
    const payload = log.args.payload;
    const decodedWormholeMessage = decodeWormholeMessage(payload);

    const destinationChain =
      decodedWormholeMessage.destinationWormholeChainId.toString();

    this.logger.info(
      { messageIdentifier: decodedWormholeMessage.messageIdentifier },
      `Collected message.`,
    );
    await this.store.setAmb(
      {
        messageIdentifier: decodedWormholeMessage.messageIdentifier,
        amb: 'wormhole',
        sourceChain: this.chainId,
        destinationChain, //TODO this should be the chainId and not the wormholeChainId
        payload: decodedWormholeMessage.payload,
        recoveryContext: log.args.sequence.toString(),
      },
      log.transactionHash,
    );

    // Decode payload
    const decodedPayload = ParsePayload(decodedWormholeMessage.payload);
    if (decodedPayload === undefined) {
      this.logger.info('Could not decode payload.');
      return;
    }

    // Set destination address for the bounty.
    await this.store.registerDestinationAddress({
      messageIdentifier: decodedWormholeMessage.messageIdentifier,
      //TODO the following contract call could fail
      destinationAddress:
        await this.messageEscrowContract.implementationAddress(
          decodedPayload?.sourceApplicationAddress,
          defaultAbiCoder.encode(['uint256'], [destinationChain]),
        ),
    });
  }
}

void new WormholeMessageSnifferWorker().run();
