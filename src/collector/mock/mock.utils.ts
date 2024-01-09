import { BigNumber, Signature } from 'ethers';
import { defaultAbiCoder, hexStripZeros, solidityPack } from 'ethers/lib/utils';
import { add0X, getSwapIdentifier } from 'src/common/utils';
import { AmbMessage } from 'src/store/types/store.types';

export function decodeMockMessage(rawMockPayload: string): AmbMessage {
  // Remove 0x.
  if (rawMockPayload.includes('0x')) rawMockPayload = rawMockPayload.slice(2);

  let counter = 0;
  // The source chain identifier is the first 32 bytes. We don't care about that.
  counter += 32 * 2;
  // The destination chain identifier is the next of the first 32 bytes.
  const destinationChain = BigInt(
    '0x' + rawMockPayload.slice(counter, (counter += 32 * 2)),
  ).toString();

  const payload = rawMockPayload.slice(counter);

  // Skip the context
  counter += 1 * 2;

  const messageIdentifier =
    '0x' + rawMockPayload.slice(counter, counter + 32 * 2);

  return {
    messageIdentifier,
    amb: 'mock',
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

export const decodeSwapIdentifierFromPayload = (
  payload: string,
  blockNumber: number,
) => {
  const sendAssetStart = 2 + 364 * 2;

  const toAccountEnd = sendAssetStart + 32 * 2 + 32 * 2 + 2;
  const toAccount = add0X(payload.substring(sendAssetStart, toAccountEnd));

  const unitsEnd = toAccountEnd + 32 * 2;
  const units = BigNumber.from(
    add0X(payload.substring(toAccountEnd, unitsEnd)),
  );

  const amountMinusFeeEnd = unitsEnd + 32 * 2 + 32 * 2 + 2;
  const fromAmountMinusFee = BigNumber.from(
    add0X(payload.substring(unitsEnd, amountMinusFeeEnd)),
  );

  const fromAsset = hexStripZeros(
    add0X(
      payload.substring(
        amountMinusFeeEnd + 32 * 2 + 2,
        amountMinusFeeEnd + 32 * 2 + 2 + 32 * 2,
      ),
    ),
  );

  const swapIdentifier = getSwapIdentifier(
    toAccount,
    units,
    fromAmountMinusFee,
    fromAsset,
    blockNumber,
  );

  return swapIdentifier;
};

export const decodeCdataFromPayload = (payload: string): string => {
  return add0X(
    payload.substring(2 * 168 + 2 * 366 + 2 * 32 + 2 * 32, payload.length),
  );
};
