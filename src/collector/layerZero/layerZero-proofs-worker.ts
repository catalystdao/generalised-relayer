import pino from 'pino';
import { Store } from '../../store/store.lib';
import { workerData, MessagePort } from 'worker_threads';
import { LayerZeroWorkerData } from './layerZero';
import {
    JsonRpcProvider,
    Log,
    LogDescription,
    zeroPadValue,
    BytesLike,
    BigNumberish,
    keccak256,
} from 'ethers6';
import {
    MonitorInterface,
    MonitorStatus,
} from '../../monitor/monitor.interface';
import { RecieveULN302__factory } from 'src/contracts/factories/RecieveULN302__factory';
import { wait, tryErrorToString } from 'src/common/utils';
import {
    RecieveULN302,
    RecieveULN302Interface,
    UlnConfigStruct,
    UlnConfigStructOutput,
} from 'src/contracts/RecieveULN302';
import { AmbPayload } from 'src/store/types/store.types';
import { BigNumber } from 'ethers';

const layerZeroChainIdToChainId: Record<number, string> = {
    40232: "11155420",
    40243: "168587773",
    40245: "84532",

}

class LayerZeroCollectorWorker {
    private readonly config: LayerZeroWorkerData;
    private readonly chainId: string;
    private recieveULN302: RecieveULN302;
    private readonly incentivesAddress: string;
    private readonly receiverAddress: string;
    private readonly recieveULN302Interface: RecieveULN302Interface;
    private readonly filterTopics: string[][];
    private readonly store: Store;
    private readonly provider: JsonRpcProvider;
    private readonly logger: pino.Logger;
    private currentStatus: MonitorStatus | null = null;
    private monitor: MonitorInterface;

    constructor() {
        this.config = workerData as LayerZeroWorkerData;
        this.chainId = this.config.chainId;
        this.store = new Store(this.chainId);
        this.provider = new JsonRpcProvider(this.config.rpc);
        this.recieveULN302 = RecieveULN302__factory.connect(
            this.config.receiverAddress,
            this.provider,
        );
        this.logger = pino(this.config.loggerOptions).child({
            worker: 'collector-LayerZero-ULNBase-worker',
            chain: this.chainId,
        });
        this.incentivesAddress = this.config.incentivesAddress;
        this.receiverAddress = this.config.receiverAddress;
        this.recieveULN302Interface =
        RecieveULN302__factory.createInterface();
        this.filterTopics = [
            [
                this.recieveULN302Interface.getEvent('PayloadVerified').topicHash,
                zeroPadValue(this.receiverAddress, 32),
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
    //TODO: CHANGE `ULNBase worker started.`,
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
            address: this.receiverAddress,
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
            proofHash,
        } = parsedLog.args as any;
        const decodedHeader = this.decodeHeader(header);

        if (decodedHeader.sender.toLowerCase() === this.config.incentivesAddress.toLowerCase()) {
            this.logger.info(
                { dvn, decodedHeader, confirmations, proofHash},
                'PayloadVerified event decoded.',
            );

            // Fetch data using the payloadHash
            const payloadData = await this.store.getAmbByPayloadHash(proofHash);

            if (!payloadData) {
                this.logger.error(
                    { proofHash },
                    'No data found in database for the given payloadHash.',
                );
                return;
            }

            this.logger.info(
                { payloadData },
                'Data fetched from database using payloadHash.',
            );

            try {
                const config = await getConfigData(
                    this.recieveULN302,
                    dvn,
                    decodedHeader.dstEid,
                );
                const isVerifiable = await checkIfVerifiable(
                    this.recieveULN302,
                    config,
                    keccak256(header),
                    proofHash,
                );
                this.logger.info({ dvn, isVerifiable }, 'Verification result checked.');
                if (isVerifiable) {
                    //TODO: Add on the source the 0x for messageIdentifier
                    const ambPayload: AmbPayload = {
                        messageIdentifier: '0x'+payloadData.messageIdentifier,
                        amb: 'layerZero',
                        destinationChainId: decodedHeader.dstEid.toString(),
                        message: payloadData.payload,
                        messageCtx: '0x',
                    };
                    this.logger.info({ proofHash }, `LayerZero proof found.`);

                    await this.store.submitProof(
                        //TODO: Remove exclamation. BAD PRACTICE!!
                        layerZeroChainIdToChainId[decodedHeader.dstEid]!,
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
    // Helper function to decode the packet header data
    private decodeHeader(encodedHeader: string): any {
        const version = encodedHeader.slice(2, 2 + 2);
        const nonce = encodedHeader.slice(2 + 2, 2 + 2 + 16);
        const srcEid = encodedHeader.slice(2 + 2 + 16, 2 + 2 + 16 + 8);
        const sender = encodedHeader.slice(2 + 2 + 16 + 8, 2 + 2 + 16 + 8 + 64).slice(24); // Last 20 bytes
        const dstEid = encodedHeader.slice(2 + 2 + 16 + 8 + 64, 2 + 2 + 16 + 8 + 64 + 8);
        const receiver = encodedHeader.slice(2 + 2 + 16 + 8 + 64 + 8, 2 + 2 + 16 + 8 + 64 + 8 + 64).slice(24); // Last 20 bytes

        return {
            version,
            nonce: BigNumber.from('0x' + nonce).toNumber(),
            srcEid: BigNumber.from('0x' + srcEid).toNumber(),
            sender: '0x' + sender,
            dstEid: BigNumber.from('0x' + dstEid).toNumber(),
            receiver: '0x' + receiver,
        };
    }
}


async function checkIfVerifiable(
    recieveULN302: RecieveULN302,
    config: UlnConfigStruct,
    headerHash: BytesLike,
    payloadHash: BytesLike,
): Promise<boolean> {
    try {
        //TODO: requiredDVNs AND optionalDVNs check
        // Call the `verifiable` method on your contract instance
        const formatConfig: UlnConfigStruct = {
            confirmations: '0x'+config.confirmations.toString(16).padStart(16, '0'),
            requiredDVNCount: '0x'+config.requiredDVNCount.toString(16).padStart(2, '0'),
            optionalDVNCount: '0x'+config.optionalDVNCount.toString(16).padStart(2, '0'),
            optionalDVNThreshold: '0x'+config.optionalDVNThreshold.toString(16).padStart(2, '0'),
            requiredDVNs: [config.requiredDVNs.toString()],
            optionalDVNs: [],
        };

        const isVerifiable = await recieveULN302.verifiable(
            formatConfig,
            headerHash,
            payloadHash,
        );
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
        const config = await recieveULN302.getUlnConfig(dvn, '0x'+remoteEid.toString(16).padStart(8, '0'));
        return config;
    } catch (error) {
        throw new Error('Error fetching configuration data.');
    }
}

// Instantiate and run the worker
void new LayerZeroCollectorWorker().run();
