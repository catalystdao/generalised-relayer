import pino from 'pino';
import { Store } from '../../store/store.lib';
import { workerData, MessagePort } from 'worker_threads';
import { LayerZeroWorkerData } from './layerZero';
import { AbiCoder, JsonRpcProvider, Log, LogDescription, zeroPadValue, Wallet, keccak256, SigningKey } from 'ethers6';
import { MonitorInterface, MonitorStatus } from '../../monitor/monitor.interface';
import { Resolver, loadResolver } from '../../resolvers/resolver';
import { ULNBaseInterface } from 'src/contracts/ULNBase';
import { ULNBase__factory } from 'src/contracts/factories/ULNBase__factory';
import { convertHexToDecimal, decodePacketMessage, encodeMessage, encodeSignature, tryErrorToString, wait } from 'src/common/utils';
import { AmbMessage, AmbPayload } from 'src/store/types/store.types';

const abi = AbiCoder.defaultAbiCoder();

class LayerZeroCollectorWorker {

    private readonly config: LayerZeroWorkerData;

    private readonly chainId: string;
    private readonly signingKey: SigningKey;
    private readonly incentivesAddress: string;
    private readonly ulnBaseInterface: ULNBaseInterface;
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
        // Create the key that will sign the cross chain messages
        this.signingKey = this.initializeSigningKey(this.config.privateKey);

        this.store = new Store(this.chainId);
        this.provider = this.initializeProvider(this.config.rpc);
        this.logger = this.initializeLogger(this.chainId);
        this.resolver = this.loadResolver(
            this.config.resolver,
            this.provider,
            this.logger
        );

        this.incentivesAddress = this.config.incentivesAddress;
        this.ulnBaseInterface = ULNBase__factory.createInterface();
        this.filterTopics = [
            [this.ulnBaseInterface.getEvent('PayloadVerified').topicHash, zeroPadValue(this.incentivesAddress, 32)]
        ];

        this.monitor = this.startListeningToMonitor(this.config.monitorPort);
    }

    // Initialize the logger
    private initializeLogger(chainId: string): pino.Logger {
        return pino(this.config.loggerOptions).child({
            worker: 'collector-LayerZero-ULNBase-worker',
            chain: chainId,
        });
    }

    // Initialize the provider
    private initializeProvider(rpc: string): JsonRpcProvider {
        return new JsonRpcProvider(rpc, undefined, { staticNetwork: true });
    }

    // Load the resolver
    private loadResolver(resolver: string | null, provider: JsonRpcProvider, logger: pino.Logger): Resolver {
        return loadResolver(resolver, provider, logger);
    }

    private initializeSigningKey(privateKey: string): SigningKey {
        return new Wallet(privateKey).signingKey;
    }

    // Start listening to the monitor service
    private startListeningToMonitor(port: MessagePort): MonitorInterface {
        const monitor = new MonitorInterface(port);

        monitor.addListener((status: MonitorStatus) => {
            this.currentStatus = status;
        });

        return monitor;
    }

    // Main run method
    async run(): Promise<void> {
        this.logger.info({ incentivesAddress: this.incentivesAddress }, `ULNBase worker started.`);

        let fromBlock = null;
        while (fromBlock == null) {
            if (this.currentStatus != null) {
                fromBlock = this.config.startingBlock ?? this.currentStatus.blockNumber;
            }
            await wait(this.config.processingInterval);
        }
        const stopBlock = this.config.stoppingBlock ?? Infinity;

        while (true) {
            try {
                let toBlock = this.currentStatus?.blockNumber;
                if (!toBlock || fromBlock > toBlock) {
                    await wait(this.config.processingInterval);
                    continue;
                }

                if (toBlock > stopBlock) {
                    toBlock = stopBlock;
                }

                const blocksToProcess = toBlock - fromBlock;
                if (this.config.maxBlocks != null && blocksToProcess > this.config.maxBlocks) {
                    toBlock = fromBlock + this.config.maxBlocks;
                }

                this.logger.info({ fromBlock, toBlock }, `Scanning PayloadVerified events.`);
                await this.queryAndProcessEvents(fromBlock, toBlock);

                if (toBlock >= stopBlock) {
                    this.logger.info({ stopBlock: toBlock }, `Finished processing blocks. Exiting worker.`);
                    break;
                }

                fromBlock = toBlock + 1;
            } catch (error) {
                this.logger.error(error, `Error on ULNBase worker`);
                await wait(this.config.retryInterval);
            }

            await wait(this.config.processingInterval);
        }

        this.monitor.close();
        await this.store.quit();
    }

    // Query and process events
    private async queryAndProcessEvents(fromBlock: number, toBlock: number): Promise<void> {
        const logs = await this.queryLogs(fromBlock, toBlock);

        for (const log of logs) {
            try {
                await this.handleEvent(log);
            } catch (error) {
                this.logger.error({ log, error }, `Failed to process event on ULNBase worker.`);
            }
        }
    }

    // Query logs from the provider
    private async queryLogs(fromBlock: number, toBlock: number): Promise<Log[]> {
        const filter = {
            address: this.incentivesAddress,
            topics: this.filterTopics,
            fromBlock,
            toBlock
        };

        let logs: Log[] | undefined;
        let i = 0;
        while (logs == undefined) {
            try {
                logs = await this.provider.getLogs(filter);
            } catch (error) {
                i++;
                this.logger.warn({ ...filter, error: tryErrorToString(error), try: i }, `Failed to 'getLogs' on ULNBase worker. Worker blocked until successful query.`);
                await wait(this.config.retryInterval);
            }
        }

        return logs;
    }

    // Handle an individual log event
    private async handleEvent(log: Log): Promise<void> {
        const parsedLog = this.ulnBaseInterface.parseLog(log);

        if (parsedLog == null) {
            this.logger.error({ topics: log.topics, data: log.data }, `Failed to parse a PayloadVerified event.`);
            return;
        }

        if (parsedLog.name != 'PayloadVerified') {
            this.logger.warn({ name: parsedLog.name, topic: parsedLog.topic }, `Event with unknown name/topic received.`);
            return;
        }

        await this.handlePayloadVerifiedEvent(log, parsedLog);
    }

    // Handle the PayloadVerified event
    private async handlePayloadVerifiedEvent(log: Log, parsedLog: LogDescription): Promise<void> {
        const event = parsedLog.args as unknown as { packet: string };

        // Extract the message identifier from the packet
        const packet = (event.packet.startsWith('0x') ? event.packet.slice(2) : event.packet).slice(32 * 2);
        const decodedPacket = decodePacketMessage(packet);
        const messageIdentifier = decodedPacket.messageIdentifier;
        this.logger.info({ messageIdentifier }, `PayloadVerified event found for message: ${messageIdentifier}`);

        // Verify if the message belongs to the relayer by consulting the store
        const ambMessage = await this.store.getAmb(messageIdentifier);

        if (ambMessage) {
            this.logger.info({ messageIdentifier }, `Message ${messageIdentifier} belongs to the relayer. Processing the event.`);

            // // Register the destination address for the bounty
            // await this.store.registerDestinationAddress({
            //     messageIdentifier: ambMessage.messageIdentifier,
            //     destinationAddress: event.recipient, // Assuming the event contains the destination address
            // });

            // Encode and sign the message for delivery
            const encodedMessage = encodeMessage(this.incentivesAddress, packet);
            const signature = this.signingKey.sign(keccak256(encodedMessage));
            const executionContext = encodeSignature(signature);

            const destinationChainId = convertHexToDecimal(ambMessage.destinationChain);

            // Construct the AmbPayload
            const ambPayload: AmbPayload = {
                messageIdentifier: ambMessage.messageIdentifier,
                amb: 'layerZero',
                destinationChainId,
                message: encodedMessage,
                messageCtx: executionContext,
            };

            this.logger.info(
                {
                    messageIdentifier: ambPayload.messageIdentifier,
                    destinationChainId: ambPayload.destinationChainId,
                },
                `LayerZero message found.`,
            );

            // Submit the proofs to any listeners. If there is a submitter, it will process the proof and submit it.
            await this.store.submitProof(destinationChainId, ambPayload);
        } else {
            this.logger.warn({ messageIdentifier }, `Message ${messageIdentifier} does not belong to the relayer. Ignoring the event.`);
        }
    }
}

// Instantiate and run the ULNBaseWorker
void new LayerZeroCollectorWorker().run();
