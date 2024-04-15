import pino, { LoggerOptions } from 'pino';
import { Store } from 'src/store/store.lib';
import { workerData } from 'worker_threads';
import {
  ParsedVaaWithBytes,
  parseVaaWithBytes,
} from '@wormhole-foundation/relayer-engine';
import { decodeWormholeMessage } from './wormhole.utils';
import { add0X } from 'src/common/utils';
import { AmbPayload } from 'src/store/types/store.types';
import { ParsePayload } from 'src/payload/decode.payload';
import {
  IncentivizedMessageEscrow,
  IncentivizedMessageEscrow__factory,
} from 'src/contracts';
import { WormholeRecoveryWorkerData } from './wormhole.types';
import { AbiCoder, JsonRpcProvider } from 'ethers6';
import { fetchVAAs } from './api-utils';

const defaultAbiCoder = AbiCoder.defaultAbiCoder();


class WormholeRecoveryWorker {
  readonly store: Store;
  readonly logger: pino.Logger;

  readonly config: WormholeRecoveryWorkerData;

  readonly provider: JsonRpcProvider;

  readonly chainId: string;

  readonly messageEscrowContract: IncentivizedMessageEscrow;

  constructor() {
    this.config = workerData as WormholeRecoveryWorkerData;

    this.chainId = this.config.chainId;

    this.store = new Store(this.chainId);
    this.logger = this.initializeLogger(
      this.chainId,
      this.config.loggerOptions,
    );
    this.provider = this.initializeProvider(this.config.rpc);
    this.messageEscrowContract = this.initializeMessageEscrow(
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
      worker: 'collector-wormhole-recovery',
      chain: chainId,
    });
  }

  private initializeProvider(rpc: string): JsonRpcProvider {
    return new JsonRpcProvider(rpc, undefined, { staticNetwork: true });
  }

  private initializeMessageEscrow(
    incentivesAddress: string,
    provider: JsonRpcProvider,
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
      {
        startingBlock: this.config.startingBlock,
        stoppingBlock: this.config.stoppingBlock,
      },
      `Wormhole recovery worker started.`,
    );

    const timestamps = await this.getTimestampsFromBlockNumbers(
      this.config.startingBlock,
      this.config.stoppingBlock,
    );

    const vaas = await this.recoverVAAs(
      timestamps.startingTimestamp,
      timestamps.stoppingTimestamp,
      this.config.wormholeChainId,
      this.config.incentivesAddress,
      this.config.processingInterval,
    );

    // Store VAAs oldest to newest
    for (const [, parsedVAA] of Array.from(vaas).reverse()) {
      try {
        await this.processVAA(parsedVAA);
      } catch (error) {
        this.logger.warn(
          { emitterAddress: parsedVAA.emitterAddress, error },
          'Failed to process recovered VAA',
        );
      }
    }
  }

  private async processVAA(vaa: ParsedVaaWithBytes): Promise<void> {
    await this.processVAAMessage(vaa);
    await this.processVAAProof(vaa);
  }

  private async processVAAMessage(vaa: ParsedVaaWithBytes): Promise<void> {
    // The following effectively runs the same logic as the 'wormhole.service.ts' worker. When
    // recovering VAAs, both this and the 'wormhole.service.ts' are executed to prevent VAAs from
    // being missed in some edge cases (when recovering right before the latest blocks).
    const decodedWormholeMessage = decodeWormholeMessage(
      vaa.payload.toString('hex'),
    );

    this.logger.info(
      { messageIdentifier: decodedWormholeMessage.messageIdentifier },
      `Collected message (recovery).`,
    );

    const destinationChain = this.config.wormholeChainIdMap.get(
      decodedWormholeMessage.destinationWormholeChainId,
    );
    if (destinationChain == undefined) {
      throw new Error(
        `Destination chain id not found for the give wormhole chain id (${decodedWormholeMessage.destinationWormholeChainId}`,
      );
    }

    const sourceChain = this.config.wormholeChainIdMap.get(vaa.emitterChain);
    if (sourceChain == undefined) {
      throw new Error(
        `Source chain id not found for the give wormhole chain id (${vaa.emitterChain}`,
      );
    }

    // Emitter address is a 32 bytes buffer: convert to hex string and keep the last 20 bytes
    const sender = '0x' + vaa.emitterAddress.toString('hex').slice(24);

    await this.store.setAmb(
      {
        messageIdentifier: decodedWormholeMessage.messageIdentifier,
        amb: 'wormhole',
        sourceChain,
        destinationChain, //TODO this should be the chainId and not the wormholeChainId
        sourceEscrow: sender,
        payload: decodedWormholeMessage.payload,
        recoveryContext: vaa.sequence.toString(),
      },
      vaa.hash.toString('hex'),
    );

    // Decode payload
    const decodedPayload = ParsePayload(decodedWormholeMessage.payload);
    if (decodedPayload === undefined) {
      throw new Error('Could not decode VAA payload.');
    }

    // Set destination address for the bounty.
    await this.store.registerDestinationAddress({
      messageIdentifier: decodedWormholeMessage.messageIdentifier,
      destinationAddress:
        //TODO the following contract call could fail
        await this.messageEscrowContract.implementationAddress(
          decodedPayload?.sourceApplicationAddress,
          defaultAbiCoder.encode(
            ['uint256'],
            [decodedWormholeMessage.destinationWormholeChainId],
          ),
        ),
    });
  }

  private async processVAAProof(vaa: ParsedVaaWithBytes): Promise<void> {
    const wormholeInfo = decodeWormholeMessage(
      add0X(vaa.payload.toString('hex')),
    );

    const destinationChain = this.config.wormholeChainIdMap.get(
      wormholeInfo.destinationWormholeChainId,
    );
    if (destinationChain == undefined) {
      throw new Error(
        `Destination chain id not found for the given wormhole chain id (${vaa.emitterChain}`,
      );
    }

    const ambPayload: AmbPayload = {
      messageIdentifier: wormholeInfo.messageIdentifier,
      amb: 'wormhole',
      destinationChainId: destinationChain,
      message: add0X(vaa.bytes.toString('hex')),
      messageCtx: '0x',
    };
    this.logger.info(
      { sequence: vaa.sequence, destinationChain },
      `Wormhole VAA found.`,
    );

    await this.store.submitProof(destinationChain, ambPayload);
  }

  private async getTimestampsFromBlockNumbers(
    startingBlock: number,
    stoppingBlock: number | undefined,
  ): Promise<{ startingTimestamp: number; stoppingTimestamp: number }> {
    // This recovery worker does not work for blocks that are in the future.
    const currentBlock = await this.provider.getBlock('latest');

    if (currentBlock == null) {
      throw new Error(
        `Unable to initialize the Wormhole recovery worker. Failed to fetch the current block.`,
      );
    }

    if (startingBlock > currentBlock.number) {
      throw new Error(
        `Unable to initialize the Wormhole recovery worker. Provided 'startingBlock' (${startingBlock}) is larger than the current block number.`,
      );
    }

    const startingTimestamp = (await this.provider.getBlock(startingBlock))!
      .timestamp;

    let stoppingTimestamp;
    if (stoppingBlock != undefined && stoppingBlock > currentBlock.number) {
      // stoppingBlock > currentBlock is a valid configuration. This will be handled by the other
      // Wormhole collector workers.
      stoppingTimestamp = currentBlock.timestamp;
    } else {
      stoppingTimestamp =
        stoppingBlock == undefined
          ? currentBlock.timestamp
          : (await this.provider.getBlock(stoppingBlock))!.timestamp;
    }

    return {
      startingTimestamp,
      stoppingTimestamp,
    };
  }

  private async recoverVAAs(
    startingTimestamp: number,
    stoppingTimestamp: number,
    womrholeChainId: number,
    emitterAddress: string,
    pageSize = 1000,
    searchDelay = 1000,
  ): Promise<Map<number, ParsedVaaWithBytes>> {
    const foundVAAs = new Map<number, ParsedVaaWithBytes>();

    let pageIndex = 0;
    while (true) {
      const pageVAAs: any[] = await fetchVAAs(
        womrholeChainId,
        emitterAddress,
        pageIndex,
        this.logger,
        pageSize,
      );

      if (pageVAAs.length == 0) break;

      let searchComplete = false;
      for (const vaa of pageVAAs) {
        const vaaTimestamp = Date.parse(vaa.timestamp) / 1000;

        // Note: the VAAs are being queried **newest to oldest**
        if (vaaTimestamp > stoppingTimestamp) continue;
        if (vaaTimestamp < startingTimestamp) {
          searchComplete = true;
          break;
        }

        const parsedVaa = parseVaaWithBytes(Buffer.from(vaa.vaa, 'base64'));

        foundVAAs.set(vaa.sequence, parsedVaa); // Use 'Map' to avoid duplicates
      }

      if (searchComplete) break;

      pageIndex++;

      await new Promise((resolve) => setTimeout(resolve, searchDelay));
    }

    return foundVAAs;
  }

}

void new WormholeRecoveryWorker().run();
