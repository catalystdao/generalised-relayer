import { AbiCoder, ethers } from "ethers6";
import pino from "pino";
import { IncentivizedMessageEscrow } from "src/contracts";

export const defaultAbiCoder = AbiCoder.defaultAbiCoder();

export const wait = (ms: number) => new Promise((res) => setTimeout(res, ms));

/**
 * Adds 0x to the begining of an address
 * @param address address string
 * @returns The string with 0x
 */
export const add0X = (address: string): string => `0x${address}`;

export const convertHexToDecimal = (hex: string) => BigInt(hex).toString();

export const tryErrorToString = (error: any): string | undefined => {
    if (error == undefined) {
        return undefined;
    }
    if (typeof error == "string") {
        return error;
    }
    try {
        return error.toString();
    } catch {
        return 'Unable to stringify error.';
    }
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
