import { JsonRpcProvider, Log, LogDescription, SigningKey, Wallet, keccak256, zeroPadValue } from 'ethers6';
import pino from 'pino';
import { convertHexToDecimal, tryErrorToString, wait } from 'src/common/utils';
import { IncentivizedMockEscrow__factory } from 'src/contracts';
import { Store } from 'src/store/store.lib';
import { AmbMessage, AmbPayload } from 'src/store/types/store.types';
import { workerData } from 'worker_threads';
import {
    decodeMockMessage,
    encodeMessage,
    encodeSignature,
} from './mock.utils';
import { MockWorkerData } from './mock';
import { IncentivizedMockEscrowInterface, MessageEvent } from 'src/contracts/IncentivizedMockEscrow';


/**
 * Example AMB implementation which uses a simple signed message to validate transactions.
 * This example worker service is provided with the following parameters:
 * @param workerData.chainId The id of the chain the worker runs for.
 * @param workerData.rpc The RPC to use for the chain.
 * @param startingBlock The block from which to start processing events (optional).
 * @param stoppingBlock The block at which to stop processing events (optional).
 * @param workerData.blockDelay Some RPCs struggle to index events/logs for very recent transactions. As a result, there are some advantages to running slighly behind. If this is set, look at events which are 'blockDelay' behind the latest block.
 * @param workerData.interval Interval of when to scan for events.
 * @param workerData.maxBlocks Max number of blocks to scan at a time.
 * @param workerData.incentivesAddress The address of the Generalised Incentive implementation for the AMB.
 * @param workerData.privateKey The key used to sign the relayed messages.
 * @param workerData.loggerOptions Logger related config to spawn a pino logger with.
 * @dev Custom additional configuration parameters should be set on config.example.yaml for future reference.
 */
class MockCollectorWorker {
    readonly store: Store;
    readonly logger: pino.Logger;

    readonly config: MockWorkerData;

    readonly provider: JsonRpcProvider;

    readonly chainId: string;
    readonly chainName: string;

    private readonly signingKey: SigningKey;

    readonly incentivesAddress: string;
    readonly incentivesAddressBytes32: string;
    readonly incentivesEscrowInterface: IncentivizedMockEscrowInterface;
    readonly filterTopics: string[][];


    constructor() {
        this.config = workerData as MockWorkerData;

        this.chainId = this.config.chainId;

        // Get a connection to the redis store.
        // The redis store has been wrapped into a lib to make it easier to standardise
        // communication between the various components.
        this.store = new Store(this.chainId);

        // Get an Ethers provider with which to collect the bounties information.
        this.provider = this.initializeProvider(this.config.rpc);

        // Create the key that will sign the cross chain messages
        this.signingKey = this.initializeSigningKey(this.config.privateKey);

        this.logger = this.initializeLogger(this.chainId);

        // Define the parameters for the rpc logs queries and message signing.
        this.incentivesAddress = this.config.incentivesAddress;
        this.incentivesAddressBytes32 = zeroPadValue(this.incentivesAddress, 32);
        this.incentivesEscrowInterface = IncentivizedMockEscrow__factory.createInterface();
        this.filterTopics = [[this.incentivesEscrowInterface.getEvent('Message').topicHash]];
    }



    // Initialization helpers
    // ********************************************************************************************

    private initializeLogger(chainId: string): pino.Logger {
        return pino(this.config.loggerOptions).child({
            worker: 'collector-mock',
            chain: chainId,
        });
    }

    private initializeProvider(rpc: string): JsonRpcProvider {
        return new JsonRpcProvider(
            rpc,
            undefined,
            { staticNetwork: true }
        )
    }

    private initializeSigningKey(privateKey: string): SigningKey {
        return new Wallet(privateKey).signingKey;
    }



    // Main handler
    // ********************************************************************************************
    async run(): Promise<void> {
        this.logger.info(
            { incentiveAddresses: this.incentivesAddress },
            `Mock collector worker started.`,
        );

        // Get the effective starting and stopping blocks.
        let startBlock = this.config.startingBlock
            ?? (await this.provider.getBlockNumber()) - this.config.blockDelay;
        const stopBlock = this.config.stoppingBlock ?? Infinity;

        await wait(this.config.interval);

        while (true) {
            try {
                let endBlock: number;
                try {
                    endBlock = (await this.provider.getBlockNumber()) - this.config.blockDelay;
                } catch (error) {
                    this.logger.error(
                        error,
                        `Failed to get the current block on the 'mock' collector service.`,
                    );
                    await wait(this.config.interval);
                    continue;
                }

                // If there has been no new block, wait.
                if (!endBlock || startBlock > endBlock) {
                    await wait(this.config.interval);
                    continue;
                }

                // Stop the relayer after a certain block.
                if (endBlock > stopBlock) {
                    endBlock = stopBlock;
                }

                // Do not process more than 'maxBlocks' within a single rpc call.
                const blocksToProcess = endBlock - startBlock;
                if (this.config.maxBlocks != null && blocksToProcess > this.config.maxBlocks) {
                    endBlock = startBlock + this.config.maxBlocks;
                }

                this.logger.info(
                    {
                        startBlock,
                        endBlock,
                    },
                    `Scanning mock messages.`,
                );

                await this.queryAndProcessEvents(startBlock, endBlock);

                if (endBlock >= stopBlock) {
                    this.logger.info(
                        { endBlock },
                        `Finished processing blocks. Exiting worker.`,
                    );
                    break;
                }

                startBlock = endBlock + 1;
            }
            catch (error) {
                this.logger.error(error, `Error on mock.worker`);
                await wait(this.config.interval)
            }

            await wait(this.config.interval);
        }

        // Cleanup worker
        await this.store.quit();
    }

    private async queryAndProcessEvents(
        fromBlock: number,
        toBlock: number
    ): Promise<void> {

        const logs = await this.queryLogs(fromBlock, toBlock);

        for (const log of logs) {
            try {
                await this.handleEvent(log);
            } catch (error) {
                this.logger.error(
                    { log, error },
                    `Failed to process event on mock collector worker.`
                );
            }
        }
    }

    private async queryLogs(
        fromBlock: number,
        toBlock: number
    ): Promise<Log[]> {
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
                this.logger.warn(
                    { ...filter, error: tryErrorToString(error), try: i },
                    `Failed to 'getLogs' on mock collector. Worker blocked until successful query.`
                );
                await wait(this.config.interval);
            }
        }

        return logs;
    }

    // Event handlers
    // ********************************************************************************************

    private async handleEvent(log: Log): Promise<void> {
        const parsedLog = this.incentivesEscrowInterface.parseLog(log);

        if (parsedLog == null) {
            this.logger.error(
                { topics: log.topics, data: log.data },
                `Failed to parse a mock escrow contract event.`,
            );
            return;
        }

        if (parsedLog.name != 'Message') {
            this.logger.warn(
                { name: parsedLog.name, topic: parsedLog.topic },
                `Event with unknown name/topic received.`,
            );
        }

        await this.handleMockMessage(log, parsedLog);
    }

    private async handleMockMessage(
        log: Log,
        parsedLog: LogDescription
    ): Promise<void> {

        const messageEvent = parsedLog.args as unknown as MessageEvent.OutputObject;
        const message = messageEvent.message;

        // Derive the message identifier
        const decodedMessage = decodeMockMessage(message);
        const amb: AmbMessage = {
            ...decodedMessage,
            amb: 'mock',
            sourceEscrow: this.config.incentivesAddress,
            blockNumber: log.blockNumber,
            blockHash: log.blockHash,
            transactionHash: log.transactionHash
        }

        // Set the collect message on-chain. This is not the proof but the raw message.
        // It can be used by plugins to facilitate other jobs.
        await this.store.setAmb(amb, log.transactionHash);

        // Set destination address for the bounty.
        await this.store.registerDestinationAddress({
            messageIdentifier: amb.messageIdentifier,
            destinationAddress: messageEvent.recipient,
        });

        // Encode and sign the message for delivery.
        // This is the proof which enables us to submit the transaciton later.
        // For Mock, this is essentially PoA with a single key. The deployment needs to match the private key available
        // to the relayer.
        const encodedMessage = encodeMessage(this.incentivesAddressBytes32, message);
        const signature = this.signingKey.sign(keccak256(encodedMessage));
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

        this.logger.info(
            {
                messageIdentifier: amb.messageIdentifier,
                destinationChainId: destinationChainId,
            },
            `Mock message found.`,
        );

        // Submit the proofs to any listeners. If there is a submitter, it will process the proof and submit it.
        await this.store.submitProof(destinationChainId, ambPayload);
    }

}

void new MockCollectorWorker().run();