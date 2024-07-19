import { IncentivizedMessageEscrow } from 'src/contracts';
import { WormholeChainConfig, WormholeChainId } from './wormhole.types';
import { AbiCoder } from 'ethers6';
import pino from 'pino';
import { tryErrorToString, wait } from 'src/common/utils';

export const defaultAbiCoder = AbiCoder.defaultAbiCoder();

export interface DecodedWormholeMessage {
    messageIdentifier: string;
    destinationWormholeChainId: WormholeChainId;
    payload: string;
}

export function decodeWormholeMessage(
    rawWormholePayload: string,
): DecodedWormholeMessage {
    let counter = rawWormholePayload.includes('0x') ? 2 : 0;

    // The destination chain identifier is the first 32 bytes.
    const destinationWormholeChainId = Number(
        BigInt('0x' + rawWormholePayload.slice(counter, (counter += 32 * 2))),
    );

    const payload = rawWormholePayload.slice(counter);

    // Skip the context
    counter += 1 * 2;

    const messageIdentifier = '0x' + rawWormholePayload.slice(counter, counter + 32 * 2);

    return {
        messageIdentifier,
        destinationWormholeChainId,
        payload,
    };
}

export function loadWormholeChainIdMap(
    wormholeChainConfigs: Map<string, WormholeChainConfig>,
) {
    const wormholeChainIdMap = new Map<WormholeChainId, string>();
    for (const [chainId, wormholeChainConfig] of wormholeChainConfigs) {
        wormholeChainIdMap.set(wormholeChainConfig.wormholeChainId, chainId);
    }

    return wormholeChainIdMap;
}


export async function getDestinationImplementation(
    fromApplication: string,
    channelId: string,
    escrowContract: IncentivizedMessageEscrow,
    cache: Record<string, Record<string, string>> = {},   // Map fromApplication + channelId => destinationImplementation
    logger: pino.Logger,
    retryInterval: number = 1000,
    maxTries: number = 3,
): Promise<string | undefined> {

    const cachedImplementation = cache[fromApplication]?.[channelId];

    if (cachedImplementation != undefined) {
        return cachedImplementation;
    }

    const destinationImplementation = await queryDestinationImplementation(
        fromApplication,
        channelId,
        escrowContract,
        logger,
        retryInterval,
        maxTries,
    );

    // Set the destination implementation cache
    if (destinationImplementation != undefined) {
        if (cache[fromApplication] == undefined) {
            cache[fromApplication] = {};
        }

        cache[fromApplication]![channelId] = destinationImplementation;
    }

    return destinationImplementation;
}

export async function queryDestinationImplementation(
    fromApplication: string,
    channelId: string,
    escrowContract: IncentivizedMessageEscrow,
    logger: pino.Logger,
    retryInterval: number = 1000,
    maxTries: number = 3,
): Promise<string | undefined> {

    for (let tryCount = 0; tryCount < maxTries; tryCount++) {
        try {
            const destinationImplementation = await escrowContract.implementationAddress(
                fromApplication,
                channelId,
            );

            logger.debug(
                {
                    fromApplication,
                    channelId,
                    destinationImplementation,
                },
                `Destination implementation queried.`
            );

            return '0x' + destinationImplementation.slice(26);  // Keep only the last 20-bytes (discard the first '0x' + 12 null bytes)
        }
        catch (error) {
            logger.warn(
                {
                    fromApplication,
                    channelId,
                    try: tryCount + 1,
                    error: tryErrorToString(error),
                },
                `Error on the destination implementation query. Retrying if possible.`
            );
        }

        await wait(retryInterval);
    }

    logger.error(
        {
            fromApplication,
            channelId,
        },
        `Failed to query the destination implementation.`
    );

    return undefined;
}
