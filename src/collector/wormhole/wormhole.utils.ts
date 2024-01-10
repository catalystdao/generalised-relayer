import { AmbMessage } from 'src/store/types/store.types';

export function decodeWormholeMessage(
  rawWormholePayload: string,
): Omit<AmbMessage, 'sourceChain'> {
  // Remove 0x.
  if (rawWormholePayload.includes('0x'))
    rawWormholePayload = rawWormholePayload.slice(2);

  let counter = 0;
  // The destination chain identifier is the first 32 bytes.
  const destinationChain = BigInt(
    '0x' + rawWormholePayload.slice(counter, (counter += 32 * 2)),
  ).toString();

  const payload = rawWormholePayload.slice(counter);

  // Skip the context
  counter += 1 * 2;

  const messageIdentifier =
    '0x' + rawWormholePayload.slice(counter, counter + 32 * 2);

  return {
    messageIdentifier,
    amb: 'wormhole',
    destinationChain,
    payload: payload,
  };
}
