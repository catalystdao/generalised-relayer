import pino from 'pino';
import { tryErrorToString, wait } from 'src/common/utils';
import { IbcEventEmitter__factory } from 'src/contracts';
import { Store } from 'src/store/store.lib';
import { AmbMessage } from 'src/store/types/store.types';
import { workerData } from 'worker_threads';
import { PolymerWorkerData } from './polymer';
import { AbiCoder, JsonRpcProvider, Log, LogDescription } from 'ethers6';
import { IbcEventEmitterInterface, SendPacketEvent } from 'src/contracts/IbcEventEmitter';

const abi = AbiCoder.defaultAbiCoder();

class PolymerCollectorSnifferWorker {

    readonly config: PolymerWorkerData;

    readonly chainId: string;

    readonly incentivesAddress: string;
    readonly polymerAddress: string;
    readonly ibcEventEmitterInterface: IbcEventEmitterInterface;
    readonly filterTopics: string[][];

    readonly store: Store;
    readonly provider: JsonRpcProvider;
    readonly logger: pino.Logger;


    constructor() {
        this.config = workerData as PolymerWorkerData;

        this.chainId = this.config.chainId;

        this.store = new Store(this.chainId);
        this.provider = this.initializeProvider(this.config.rpc);
        this.logger = this.initializeLogger(this.chainId);

        // Define the parameters for the rpc logs queries
        this.incentivesAddress = this.config.incentivesAddress;
        this.polymerAddress = this.config.polymerAddress;
        this.ibcEventEmitterInterface = IbcEventEmitter__factory.createInterface();
        this.filterTopics = [[this.ibcEventEmitterInterface.getEvent('SendPacket').topicHash]];
    }



    // Initialization helpers
    // ********************************************************************************************

    private initializeLogger(chainId: string): pino.Logger {
        return pino(this.config.loggerOptions).child({
            worker: 'collector-polymer-sniffer',
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



    // Main handler
    // ********************************************************************************************
    async run(): Promise<void> {
        this.logger.info(
            { incentiveAddresses: this.incentivesAddress },
            `Polymer collector sniffer worker started.`,
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
                        `Failed to get the current block on the 'polymer' collector service.`,
                    );
                    await wait(this.config.interval);
                    continue;
                }

                if (!endBlock || startBlock > endBlock) {
                    await wait(this.config.interval);
                    continue;
                }

                if (endBlock > stopBlock) {
                    endBlock = stopBlock;
                }

                const blocksToProcess = endBlock - startBlock;
                if (this.config.maxBlocks != null && blocksToProcess > this.config.maxBlocks) {
                    endBlock = startBlock + this.config.maxBlocks;
                }

                this.logger.info(
                    {
                        startBlock,
                        endBlock,
                    },
                    `Scanning polymer messages.`,
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
                this.logger.error(error, `Error on polymer.worker`);
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
                    `Failed to process event on polymer collector sniffer worker.`
                );
            }
        }
    }

    private async queryLogs(
        fromBlock: number,
        toBlock: number
    ): Promise<Log[]> {
        const filter = {
            address: this.polymerAddress,
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
                    `Failed to 'getLogs' on polymer collector sniffer. Worker blocked until successful query.`
                );
                await wait(this.config.interval);
            }
        }

        return logs;
    }

    // Event handlers
    // ********************************************************************************************

    private async handleEvent(log: Log): Promise<void> {
        const parsedLog = this.ibcEventEmitterInterface.parseLog(log);

        if (parsedLog == null) {
            this.logger.error(
                { topics: log.topics, data: log.data },
                `Failed to parse a polymer contract event.`,
            );
            return;
        }

        if (parsedLog.name != 'SendPacket') {
            this.logger.warn(
                { name: parsedLog.name, topic: parsedLog.topic },
                `Event with unknown name/topic received.`,
            );
            return;
        }

        await this.handleSendPacketEvent(log, parsedLog);
    }

    private async handleSendPacketEvent(
        log: Log,
        parsedLog: LogDescription
    ): Promise<void> {

        const event = parsedLog.args as unknown as SendPacketEvent.OutputObject;
        const destinationChain: string = event.sourceChannelId;

        // Decode the Universal channel payload
        const packet = event.packet.startsWith('0x')
            ? event.packet.slice(2)
            : event.packet;

        let params: [string, bigint, string, string];
        try {
            params = abi.decode(
                ['tuple(bytes32, uint256, bytes32, bytes)'],
                event.packet,
            )[0];
        } catch (error) {
            this.logger.debug(
                {
                    error: tryErrorToString(error),
                },
                `Couldn't decode a Polymer message. Likely because it is not a UniversalChannel Package.`,
            );
            return;
        }

        const incentivisedMessageEscrowFromPacket: string =
            '0x' + params[0].replaceAll('0x', '').slice(12 * 2);

        if (
            incentivisedMessageEscrowFromPacket.toLowerCase() !=
                this.config.incentivesAddress.toLowerCase() ||
            packet.length <= 384 + 64 * 2
        ) {
            return;
        }

        // Derive the message identifier
        const messageIdentifier = '0x' + params[3]
            .replaceAll('0x', '').slice(1 * 2, 1 * 2 + 32 * 2);

        const amb: AmbMessage = {
            messageIdentifier,
            amb: 'polymer',
            sourceChain: this.chainId,
            destinationChain,
            sourceEscrow: "", // ! TODO implement (important for underwriting)
            payload: params[3],
            blockNumber: log.blockNumber,
            blockHash: log.blockHash,
            transactionHash: log.transactionHash
        };

        // Set the collect message  on-chain. This is not the proof but the raw message.
        // It can be used by plugins to facilitate other jobs.
        await this.store.setAmb(amb, log.transactionHash);

        this.logger.info(
            {
                messageIdentifier: amb.messageIdentifier,
                destinationChainId: destinationChain,
            },
            `Polymer message found.`,
        );
    }

}

void new PolymerCollectorSnifferWorker().run();