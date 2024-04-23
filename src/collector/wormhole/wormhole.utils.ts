import { WormholeChainConfig, WormholeChainId } from './wormhole.types';

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
