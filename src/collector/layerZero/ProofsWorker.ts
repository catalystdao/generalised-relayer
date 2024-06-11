import pino from 'pino';
import { Store } from '../../store/store.lib';
import { workerData, MessagePort } from 'worker_threads';
import { LayerZeroWorkerData } from './layerZero';
import {
  JsonRpcProvider,
  Log,
  LogDescription,
  zeroPadValue,
  Wallet,
  SigningKey,
  BytesLike,
  ethers,
  AbiCoder,
  BigNumberish,
} from 'ethers6';
import {
  MonitorInterface,
  MonitorStatus,
} from '../../monitor/monitor.interface';
import { Resolver, loadResolver } from '../../resolvers/resolver';
import { RecieveULN302__factory } from 'src/contracts/factories/RecieveULN302__factory';
import { wait, tryErrorToString } from 'src/common/utils';
import {
  RecieveULN302,
  UlnConfigStruct,
  UlnConfigStructOutput,
} from 'src/contracts/RecieveULN302';
import { arrayify } from 'ethers/lib/utils';
import { AmbPayload } from 'src/store/types/store.types';

type GARPDecodedMessage = {
  context: string; // Context of the message, returned as a hexadecimal string
  messageIdentifier: string; // Unique identifier of the message, as a hex string
  sender: string; // Ethereum address of the sender
  destination: string; // Ethereum address of the destination
  payload: string; // The actual message content as a string
};

type PacketHeader = {
  version: number; // Corresponds to PACKET_VERSION
  nonce: number | bigint; // Nonce, a counter or similar (make sure to match the actual data type used in Solidity)
  srcEid: number | bigint; // Source EID, possibly an ID or a unique identifier for the source
  sender: string; // Sender address in a string form (though in Solidity it is bytes32, in TS we use string for addresses)
  dstEid: number | bigint; // Destination EID, similar to srcEid
  receiver: string; // Receiver address
};
class LayerZeroCollectorWorker {
  private readonly config: LayerZeroWorkerData;
  private readonly chainId: string;
  private recieveULN302: RecieveULN302;
  private readonly signingKey: SigningKey;
  private readonly incentivesAddress: string;
  private readonly bridgeAddress: string;
  private readonly recieveULN302Interface =
    RecieveULN302__factory.createInterface();
  private readonly filterTopics: string[][];
  private readonly resolver: Resolver;
  private readonly store: Store;
  private readonly provider: JsonRpcProvider;
  private readonly logger: pino.Logger;
  private currentStatus: MonitorStatus | null = null;
  private monitor: MonitorInterface;

  constructor() {
    this.config = workerData as LayerZeroWorkerData;
    this.chainId = this.config.chainId;
    this.signingKey = new Wallet(this.config.privateKey).signingKey;
    this.store = new Store(this.chainId);
    this.provider = new JsonRpcProvider(this.config.rpc);
    this.recieveULN302 = RecieveULN302__factory.connect(
      this.config.bridgeAddress,
      this.provider,
    );
    this.logger = pino(this.config.loggerOptions).child({
      worker: 'collector-LayerZero-ULNBase-worker',
      chain: this.chainId,
    });
    this.resolver = loadResolver(
      this.config.resolver,
      this.provider,
      this.logger,
    );
    this.incentivesAddress = this.config.incentivesAddress;
    this.bridgeAddress = this.config.bridgeAddress;

    this.filterTopics = [
      [
        this.recieveULN302Interface.getEvent('PayloadVerified').topicHash,
        zeroPadValue(this.bridgeAddress, 32),
      ],
    ];
    this.monitor = this.startListeningToMonitor(this.config.monitorPort);
  }

  private startListeningToMonitor(port: MessagePort): MonitorInterface {
    const monitor = new MonitorInterface(port);
    monitor.addListener((status: MonitorStatus) => {
      this.currentStatus = status;
    });
    return monitor;
  }

  async run(): Promise<void> {
    this.logger.info(
      { incentivesAddress: this.incentivesAddress },
      `ULNBase worker started.`,
    );

    let fromBlock = null;
    while (fromBlock === null) {
      if (this.currentStatus !== null) {
        fromBlock = this.config.startingBlock ?? this.currentStatus.blockNumber;
      }
      await wait(this.config.processingInterval);
    }
    const stopBlock = this.config.stoppingBlock ?? Infinity;

    while (true) {
      let toBlock = this.currentStatus?.blockNumber;
      if (!toBlock || fromBlock > toBlock) {
        await wait(this.config.processingInterval);
        continue;
      }
      if (toBlock > stopBlock) {
        toBlock = stopBlock;
      }
      const blocksToProcess = toBlock - fromBlock;
      if (
        this.config.maxBlocks != null &&
        blocksToProcess > this.config.maxBlocks
      ) {
        toBlock = fromBlock + this.config.maxBlocks;
      }
      this.logger.info(
        { fromBlock, toBlock },
        `Scanning PayloadVerified events.`,
      );
      await this.queryAndProcessEvents(fromBlock, toBlock);
      if (toBlock >= stopBlock) {
        this.logger.info(
          { stopBlock: toBlock },
          `Finished processing blocks. Exiting worker.`,
        );
        break;
      }
      fromBlock = toBlock + 1;
    }
    this.monitor.close();
    await this.store.quit();
  }

  private async queryAndProcessEvents(
    fromBlock: number,
    toBlock: number,
  ): Promise<void> {
    const logs = await this.queryLogs(fromBlock, toBlock);
    for (const log of logs) {
      try {
        await this.handleEvent(log);
      } catch (error) {
        this.logger.error(
          { log, error },
          `Failed to process event on Layer Zero Proofs Collector Worker.`,
        );
      }
    }
  }

  private async queryLogs(fromBlock: number, toBlock: number): Promise<Log[]> {
    const filter = {
      address: this.incentivesAddress,
      topics: this.filterTopics,
      fromBlock,
      toBlock,
    };
    let logs: Log[] | undefined;
    let i = 0;
    while (logs === undefined) {
      try {
        logs = await this.provider.getLogs(filter);
      } catch (error) {
        i++;
        this.logger.warn(
          { ...filter, error: tryErrorToString(error), try: i },
          `Failed to 'getLogs' on ULNBase worker. Worker blocked until successful query.`,
        );
        await wait(this.config.retryInterval);
      }
    }
    return logs;
  }

  private async handleEvent(log: Log): Promise<void> {
    const parsedLog = this.recieveULN302Interface.parseLog(log);
    if (parsedLog === null) {
      this.logger.error(
        { topics: log.topics, data: log.data },
        `Failed to parse a PayloadVerified event.`,
      );
      return;
    }
    if (parsedLog.name !== 'PayloadVerified') {
      this.logger.warn(
        { name: parsedLog.name, topic: parsedLog.topic },
        `Event with unknown name/topic received.`,
      );
      return;
    }
    await this.handlePayloadVerifiedEvent(log, parsedLog);
  }

  private async handlePayloadVerifiedEvent(
    log: Log,
    parsedLog: LogDescription,
  ): Promise<void> {
    const {
      dvn,
      header,
      confirmations,
      payloadHash: payloadHash,
    } = parsedLog.args as any;
    const decodedHeader = this.decodePacketHeader(arrayify(header));
    if (decodedHeader.sender == this.config.incentivesAddress) {
      this.logger.info(
        { dvn, decodedHeader, confirmations, payloadHash: payloadHash },
        'PayloadVerified event decoded.',
      );

      const GARPMessageDecoded = await decodeMessageWithContext(payloadHash);
      try {
        const config = await getConfigData(
          this.recieveULN302,
          dvn,
          decodedHeader.dstEid,
        );
        const isVerifiable = await checkIfVerifiable(
          this.recieveULN302,
          config,
          header,
          payloadHash,
        );
        this.logger.info({ dvn, isVerifiable }, 'Verification result checked.');
        if (isVerifiable) {
          await this.store.setAmb(
            {
              messageIdentifier: GARPMessageDecoded.messageIdentifier,
              amb: 'LayerZero',
              sourceChain: decodedHeader.srcEid.toString(),
              destinationChain: decodedHeader.dstEid.toString(),
              sourceEscrow: decodedHeader.sender,
              payload: GARPMessageDecoded.payload,
              recoveryContext: 'None',
            },
            log.transactionHash,
          );
          
          const ambPayload: AmbPayload = {
            messageIdentifier: GARPMessageDecoded.messageIdentifier,
            amb: 'LayerZero',
            destinationChainId: decodedHeader.dstEid.toString(),
            message: payloadHash,
            messageCtx: GARPMessageDecoded.context,
          };
          this.logger.info({ payloadHash }, `LayerZero proof found.`);

          await this.store.submitProof(
            decodedHeader.dstEid.toString(),
            ambPayload,
          );
        }
      } catch (error) {
        this.logger.error(
          { error: tryErrorToString(error) },
          'Error during configuration verification.',
        );
      }
    }
  }
  private decodePacketHeader(encodedHeader: Uint8Array): PacketHeader {
    const decoder = new TextDecoder('utf-8');
    let offset = 0;
    const version = parseInt(
      decoder.decode(encodedHeader.slice(offset, offset + 1)),
    );
    offset += 1;
    const nonce = parseInt(
      decoder.decode(encodedHeader.slice(offset, offset + 8)),
    );
    offset += 8;
    const srcEid = parseInt(
      decoder.decode(encodedHeader.slice(offset, offset + 8)),
    );
    offset += 8;
    const sender = ethers.getAddress(
      ethers.hexlify(encodedHeader.slice(offset, offset + 32)),
    );
    offset += 32;
    const dstEid = parseInt(
      decoder.decode(encodedHeader.slice(offset, offset + 8)),
    );
    offset += 8;
    const receiver = ethers.getAddress(
      ethers.hexlify(encodedHeader.slice(offset)),
    );
    return { version, nonce, srcEid, sender, dstEid, receiver };
  }
}

async function decodeMessageWithContext(
  encodedMessage: string,
): Promise<GARPDecodedMessage> {
  // Convert the encoded message string to a byte array
  const messageBytes = arrayify(encodedMessage);

  // Decode parts of the message
  const context = messageBytes[0] || ''; // First byte for context
  const messageIdentifier = ethers.hexlify(messageBytes.slice(1, 33)); // Next 32 bytes for message identifier
  const sender = ethers.getAddress(ethers.hexlify(messageBytes.slice(33, 53))); // Next 20 bytes for sender address
  const destination = ethers.getAddress(
    ethers.hexlify(messageBytes.slice(53, 73)),
  ); // Next 20 bytes for destination address
  const payload = ethers.toUtf8String(messageBytes.slice(73)); // Remaining bytes for message payload

  return {
    context: context.toString(16), // Convert context byte to hex string
    messageIdentifier,
    sender,
    destination,
    payload,
  };
}

async function checkIfVerifiable(
  recieveULN302: RecieveULN302,
  config: UlnConfigStruct,
  headerHash: BytesLike,
  payloadHash: BytesLike,
): Promise<boolean> {
  try {
    // Call the `verifiable` method on your contract instance
    const isVerifiable = await recieveULN302.verifiable(
      config,
      headerHash,
      payloadHash,
    );
    console.log('Is verifiable: ', isVerifiable);
    return isVerifiable;
  } catch (error) {
    console.error('Failed to verify the configuration: ', error);
    throw new Error('Error verifying the configuration.');
  }
}
async function getConfigData(
  recieveULN302: RecieveULN302,
  dvn: string,
  remoteEid: BigNumberish,
): Promise<UlnConfigStructOutput> {
  try {
    // Call the `getUlnConfig` method on your contract instance
    const config = await recieveULN302.getUlnConfig(dvn, remoteEid);
    console.log('Configuration Data: ', config);
    return config;
  } catch (error) {
    console.error('Failed to get configuration data: ', error);
    throw new Error('Error fetching configuration data.');
  }
}

// Instantiate and run the worker
new LayerZeroCollectorWorker().run();
