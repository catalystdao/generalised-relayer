export function decodeBytes65Address(addressBytes65: string): string {
  let workingAddress = addressBytes65;
  if (addressBytes65.slice(0, 2) === '0x')
    workingAddress = addressBytes65.slice(2);

  const length = parseInt(workingAddress.slice(0, 2), 16);

  const totalLength = 2 + 64 * 2;
  const startingPoint = totalLength - length * 2;
  return '0x' + workingAddress.slice(startingPoint);
}

export function encodeRelayerAddress(relayerAddress: string): string {
  return '0x' + relayerAddress.slice(relayerAddress.length - 20 * 2);
}

/* 
    Common Payload (beginning)
       CONTEXT                           0   (1 byte)
       + MESSAGE_IDENTIFIER              1   (32 bytes)
       + FROM_APPLICATION_LENGTH         33  (1 byte)
       + FROM_APPLICATION                34  (64 bytes)
    
    Context-depending Payload
       CTX0 - 0x00 - Source to Destination
         + TO_APPLICATION_LENGTH         98  (1 byte)
         + TO_APPLICATION                99  (64 bytes)
         + MAX_GAS                       163 (6 bytes)
        => MESSAGE_START                 169 (remainder)
    
       CTX1 - 0x01 - Destination to Source
         + RELAYER_RECIPITENT            98  (32 bytes)
         + GAS_SPENT                     130 (6 bytes)
         + EXECUTION_TIME                136 (8 bytes)
        => MESSAGE_START                 144 (remainder)

    ** Contexts **
    bytes1 constant CTX_SOURCE_TO_DESTINATION       = 0x00;
    bytes1 constant CTX_DESTINATION_TO_SOURCE       = 0x01;
 */

export enum MessageContext {
  CTX_SOURCE_TO_DESTINATION,
  CTX_DESTINATION_TO_SOURCE,
}

type COMMON_MESSAGE = {
  context: MessageContext;
  messageIdentifier: string;
  rawSourceApplicationAddress: string;
  sourceApplicationAddress: string;
  message: string;
};

export type SOURCE_TO_DESTINATION = COMMON_MESSAGE & {
  context: MessageContext.CTX_SOURCE_TO_DESTINATION;
  messageIdentifier: string;
  rawToApplication: string;
  toApplication: string;
  deadline: bigint;
  maxGasLimit: bigint;
};
export type DESTINATION_TO_SOURCE = COMMON_MESSAGE & {
  context: MessageContext.CTX_DESTINATION_TO_SOURCE;
  messageIdentifier: string;
  relayerRecipient: string;
  gasSpent: bigint;
  executionTime: number;
  rawMessage: string;
};

export type GeneralisedIncentiveMessage =
  | SOURCE_TO_DESTINATION
  | DESTINATION_TO_SOURCE;

export function ParsePayload(
  payload: string,
): GeneralisedIncentiveMessage | undefined {
  const generalisedIncentiveMessage = payload.replaceAll('0x', '');

  let counter = 0;
  const context: MessageContext = parseInt(
    generalisedIncentiveMessage.slice(counter, (counter += 2)),
    16,
  );
  const messageIdentifier = generalisedIncentiveMessage.slice(
    counter,
    (counter += 32 * 2),
  );
  const applicationAddress = generalisedIncentiveMessage.slice(
    counter,
    (counter += 32 * 2 * 2 + 2),
  );
  const common_message = {
    messageIdentifier,
    rawSourceApplicationAddress: applicationAddress,
    sourceApplicationAddress: decodeBytes65Address(applicationAddress),
  };
  if (context === MessageContext.CTX_SOURCE_TO_DESTINATION) {
    const toApplication = generalisedIncentiveMessage.slice(
      counter,
      (counter += 32 * 2 * 2 + 2),
    );
    const deadline = BigInt(
      '0x' + generalisedIncentiveMessage.slice(
        counter,
        (counter += 8 * 2)
      )
    );
    const maxGasLimit = BigInt(
      '0x' + generalisedIncentiveMessage.slice(counter, (counter += 6 * 2)),
    );
    const message = generalisedIncentiveMessage.slice(counter);
    return {
      ...common_message,
      context: context,
      rawToApplication: toApplication,
      toApplication: decodeBytes65Address(toApplication),
      deadline,
      maxGasLimit,
      message,
    };
  } else if (context === MessageContext.CTX_DESTINATION_TO_SOURCE) {
    const relayerRecipient = generalisedIncentiveMessage.slice(
      counter,
      (counter += 32 * 2),
    );
    const gasSpent = BigInt(
      '0x' + generalisedIncentiveMessage.slice(counter, (counter += 6 * 2)),
    );
    const executionTime = parseInt(
      generalisedIncentiveMessage.slice(counter, (counter += 8 * 2)),
      16,
    );
    // The raw message also contains the generalised incentive status code.
    // TODO: Take a second look at this. Currently it is not implemented correctly and it might cause issues in the future.
    const rawMessage = generalisedIncentiveMessage.slice((counter += 2));
    const message = generalisedIncentiveMessage.slice(counter);
    return {
      ...common_message,
      context: context,
      relayerRecipient,
      gasSpent,
      executionTime,
      rawMessage,
      message,
    };
  } else {
    console.log(
      `Context not found: ${context}, ${generalisedIncentiveMessage} parsing as undefiend`,
    );
    return undefined;
    // throw Error(`Context not found? Could be incorrectly decoded message. Context: ${context}`)
  }
}
