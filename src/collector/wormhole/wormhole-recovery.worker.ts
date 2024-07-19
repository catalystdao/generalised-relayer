import pino, { LoggerOptions } from 'pino';
import { Store } from 'src/store/store.lib';
import { workerData } from 'worker_threads';
import {
    ParsedVaaWithBytes,
    parseVaaWithBytes,
} from '@wormhole-foundation/relayer-engine';
import { decodeWormholeMessage } from './wormhole.utils';
import { add0X, defaultAbiCoder, getDestinationImplementation, tryErrorToString, wait } from 'src/common/utils';
import { AMBMessage, AMBProof } from 'src/store/store.types';
import { ParsePayload } from 'src/payload/decode.payload';
import {
    IncentivizedMessageEscrow,
    IncentivizedMessageEscrow__factory,
} from 'src/contracts';
import { WormholeRecoveryWorkerData } from './wormhole.types';
import { JsonRpcProvider } from 'ethers6';
import { fetchVAAs } from './api-utils';
import { Resolver, loadResolver } from 'src/resolvers/resolver';

interface RecoveredVAAData {
    vaa: ParsedVaaWithBytes,
    transactionHash: string,
}

class WormholeRecoveryWorker {
    private readonly store: Store;
    private readonly logger: pino.Logger;

    private readonly config: WormholeRecoveryWorkerData;

    private readonly provider: JsonRpcProvider;

    private readonly chainId: string;

    private readonly messageEscrowContract: IncentivizedMessageEscrow;

    private readonly resolver: Resolver;

    private readonly destinationImplementationCache: Record<string, Record<string, string>> = {};   // Map fromApplication + toChainId => destinationImplementation

    constructor() {
        this.config = workerData as WormholeRecoveryWorkerData;

        this.chainId = this.config.chainId;

        this.store = new Store();
        this.logger = this.initializeLogger(
            this.chainId,
            this.config.loggerOptions,
        );
        this.provider = this.initializeProvider(this.config.rpc);
        this.resolver = this.loadResolver(
            this.config.resolver,
            this.provider,
            this.logger
        );
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

    private loadResolver(
        resolver: string | null,
        provider: JsonRpcProvider,
        logger: pino.Logger
    ): Resolver {
        return loadResolver(resolver, provider, logger);
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

        const recoveredVAAs = await this.recoverVAAs(
            timestamps.startingTimestamp,
            timestamps.stoppingTimestamp,
            this.config.wormholeChainId,
            this.config.incentivesAddress,
            this.config.processingInterval,
        );

        // Store VAAs oldest to newest
        for (const [, data] of Array.from(recoveredVAAs).reverse()) {
            try {
                await this.processVAA(data);
            } catch (error) {
                this.logger.warn(
                    { emitterAddress: data.vaa.emitterAddress, error },
                    'Failed to process recovered VAA',
                );
            }
        }
    }

    private async processVAA(recoveredVAAData: RecoveredVAAData): Promise<void> {
        await this.processVAAMessage(recoveredVAAData);
        await this.processVAAProof(recoveredVAAData);
    }

    private async processVAAMessage(recoveredVAAData: RecoveredVAAData): Promise<void> {
        // The following effectively runs the same logic as the 'wormhole.service.ts' worker. When
        // recovering VAAs, both this and the 'wormhole.service.ts' are executed to prevent VAAs from
        // being missed in some edge cases (when recovering right before the latest blocks).
        const vaa = recoveredVAAData.vaa;

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

        // Decode payload
        const decodedPayload = ParsePayload(decodedWormholeMessage.payload);
        if (decodedPayload === undefined) {
            throw new Error('Could not decode VAA payload.');
        }

        const channelId = defaultAbiCoder.encode(
            ['uint256'],
            [decodedWormholeMessage.destinationWormholeChainId],
        );

        const toIncentivesAddress = await getDestinationImplementation(
            decodedPayload.sourceApplicationAddress,
            channelId,
            this.messageEscrowContract,
            this.destinationImplementationCache,
            this.logger,
            this.config.retryInterval
        );

        const transactionHash = recoveredVAAData.transactionHash;
        const transactionBlockMetadata = await this.queryTransactionBlockMetadata(transactionHash);

        if (transactionBlockMetadata == null) {
            throw new Error(
                `Failed to recover wormhole VAA: transaction receipt not found for the given hash (${transactionHash}).`
            );
        }

        const transactionBlockNumber = await this.resolver.getTransactionBlockNumber(
            transactionBlockMetadata.blockNumber
        );

        const ambMessage: AMBMessage = {
            messageIdentifier: decodedWormholeMessage.messageIdentifier,

            amb: 'wormhole',
            fromChainId: sourceChain,
            toChainId: destinationChain,
            fromIncentivesAddress: sender,
            toIncentivesAddress,

            incentivesPayload: decodedWormholeMessage.payload,
            recoveryContext: vaa.sequence.toString(),

            transactionBlockNumber,

            transactionHash,
            blockHash: transactionBlockMetadata.blockHash,
            blockNumber: transactionBlockMetadata.blockNumber,
        };

        await this.store.setAMBMessage(
            this.chainId,
            ambMessage,
        );
    }

    private async processVAAProof(recoveredVAAData: RecoveredVAAData): Promise<void> {
        const vaa = recoveredVAAData.vaa;

        const wormholeInfo = decodeWormholeMessage(
            add0X(vaa.payload.toString('hex')),
        );

        const sourceChain = this.config.wormholeChainIdMap.get(
            vaa.emitterChain,
        );
        if (sourceChain == undefined) {
            throw new Error(
                `Source chain id not found for the given wormhole chain id (${vaa.emitterChain})`
            )
        }

        const destinationChain = this.config.wormholeChainIdMap.get(
            wormholeInfo.destinationWormholeChainId,
        );
        if (destinationChain == undefined) {
            throw new Error(
                `Destination chain id not found for the given wormhole chain id (${wormholeInfo.destinationWormholeChainId}`,
            );
        }

        const ambPayload: AMBProof = {
            messageIdentifier: wormholeInfo.messageIdentifier,

            amb: 'wormhole',
            fromChainId: sourceChain,
            toChainId: destinationChain,

            message: add0X(vaa.bytes.toString('hex')),
            messageCtx: '0x',
        };
        this.logger.info(
            { sequence: vaa.sequence, destinationChain },
            `Wormhole VAA found.`,
        );

        await this.store.setAMBProof(destinationChain, ambPayload);
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
            stoppingTimestamp = stoppingBlock == undefined
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
    ): Promise<Map<number, RecoveredVAAData>> {
        const foundVAAs = new Map<number, RecoveredVAAData>();

        let pageIndex = 0;
        while (true) {
            const pageVAAs: any[] = await fetchVAAs(
                womrholeChainId,
                emitterAddress,
                this.config.isTestnet,
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

                // Use 'Map' to avoid duplicates
                foundVAAs.set(
                    vaa.sequence,
                    {
                        vaa: parsedVaa,
                        transactionHash: '0x' + vaa.txHash,
                    }
                );
            }

            if (searchComplete) break;

            pageIndex++;

            await new Promise((resolve) => setTimeout(resolve, searchDelay));
        }

        return foundVAAs;
    }

    private async queryTransactionBlockMetadata(
        transactionHash: string,
        maxTries: number = 3,
    ): Promise<{
        blockHash: string,
        blockNumber: number,
    } | undefined> {

        for (let tryCount = 0; tryCount < maxTries; tryCount++) {
            try {
                const transactionReceipt = await this.provider.getTransactionReceipt(transactionHash);
                if (transactionReceipt != undefined) {
                    return {
                        blockHash: transactionReceipt.blockHash,
                        blockNumber: transactionReceipt.blockNumber,
                    };
                }

                throw new Error('Transaction receipt is null.');
            }
            catch (error) {
                this.logger.warn(
                    {
                        transactionHash,
                        try: tryCount + 1,
                        error: tryErrorToString(error),
                    },
                    `Failed to query transaction receipt. Will retry if possible.`
                );
            }

            await wait(this.config.retryInterval);
        }

        this.logger.warn(
            {
                transactionHash
            },
            `Failed to query transaction receipt.`
        );

        return undefined;
    }

}

void new WormholeRecoveryWorker().run();
