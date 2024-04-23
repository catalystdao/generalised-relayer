import pino from "pino";
import { wait } from "src/common/utils";

export const WORMHOLESCAN_API_ENDPOINT = 'https://api.testnet.wormholescan.io';

export async function fetchVAAs(
    womrholeChainId: number,
    emitterAddress: string,
    pageIndex: number,
    logger: pino.Logger,
    pageSize = 1000,
    maxTries = 20,
    retryInterval = 2000,
): Promise<any[]> {
    for (let tryCount = 0; tryCount < maxTries; tryCount++) {
        try {
            const response = await fetch(
                `${WORMHOLESCAN_API_ENDPOINT}/api/v1/vaas/${womrholeChainId}/${emitterAddress}?page=${pageIndex}&pageSize=${pageSize}`,
            );

            const body = await response.text();

            return JSON.parse(body).data;
        } catch (error) {
            logger.warn(
                {
                    womrholeChainId,
                    emitterAddress,
                    pageIndex,
                    pageSize,
                    maxTries,
                    try: tryCount,
                },
                `Error on VAAs query.`,
            );

            await wait(retryInterval);
        }
    }

    throw new Error(`Failed to query VAAs: max tries reached.`);
}