import { BigNumber, Signature } from 'ethers';
import { defaultAbiCoder, hexStripZeros, solidityPack } from 'ethers/lib/utils';
import { add0X, getSwapIdentifier } from 'src/common/utils';
import { AmbMessage } from 'src/store/types/store.types';

export function decodeMockMessage(rawMockPayload: string): AmbMessage {
  // Remove 0x.
  if (rawMockPayload.includes('0x')) rawMockPayload = rawMockPayload.slice(2);

  let counter = 0;
  const sourceChain = BigInt(
    '0x' + rawMockPayload.slice(counter, (counter += 32 * 2)),
  ).toString();
  // The destination chain identifier is the next of the first 32 bytes.
  const destinationChain = BigInt(
    '0x' + rawMockPayload.slice(counter, (counter += 32 * 2)),
  ).toString();

  const payload = '0x' + rawMockPayload.slice(counter);

  // Skip the context
  counter += 1 * 2;

  const messageIdentifier =
    '0x' + rawMockPayload.slice(counter, counter + 32 * 2);

  return {
    messageIdentifier,
    amb: 'mock',
    sourceChain,
    destinationChain,
    payload: payload,
  };
}

/**
 * EncodesMessage a message
 * @param address The contract address
 * @param message The Message string
 * @returns The Encoded message
 */
export const encodeMessage = (address: string, message: string): string => {
  return solidityPack(['bytes', 'bytes'], [address, message]);
};

/**
 * Encodes the signature
 * @param signature The signature
 * @returns The Encoded execution context
 */
export const encodeSignature = (signature: Signature): string => {
  return defaultAbiCoder.encode(
    ['uint8', 'uint256', 'uint256'],
    [signature.v, signature.r, signature.s],
  );
};

export const decodeEventMessage = (
  message: string,
): [string, string, string] => {
  // The 'message' field within the 'Message' event is encoded as:
  // - Source identifier: 32 bytes
  // - Destination identifier: 32 bytes
  // - App message: bytes

  // Note that on a hex-encoded string one byte is 2 characters

  const sourceIdentifier = add0X(message.slice(2, 2 + 32 * 2));
  const destinationIdentifier = add0X(
    message.slice(2 + 32 * 2, 2 + 32 * 2 + 32 * 2),
  );
  const baseMessage = add0X(message.slice(2 + 32 * 2 + 32 * 2));

  return [sourceIdentifier, destinationIdentifier, baseMessage];
};

export const decodeMessageIdentifierFromPayload = (message: string): string => {
  return add0X(message.slice(2 + 1 * 2, 2 + 1 * 2 + 32 * 2)); // See MessagePayload.sol for reference (GeneralisedIncentives repo)
};