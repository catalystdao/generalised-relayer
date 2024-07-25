// Store types
// ************************************************************************************************

export interface TransactionDescription {
    transactionHash: string;
    blockHash: string;
    blockNumber: number;
}

export interface KeyActionMessage {
    key: string;
    action: 'set' | 'del';
}



// AMB related types
// ************************************************************************************************

export interface AMBMessage<T = any> extends TransactionDescription {
    messageIdentifier: string;

    amb: string;
    fromChainId: string;
    toChainId: string;
    fromIncentivesAddress: string;
    toIncentivesAddress?: string;    

    incentivesPayload: string;
    recoveryContext?: string;
    additionalData?: T;

    transactionBlockNumber?: number;    // The block number as seen by the transaction.

    priority?: boolean;
};

export type AMBMessageJSON<T = any> = AMBMessage<T>;


export interface AMBProof {
    messageIdentifier: string;

    amb: string;
    fromChainId: string;
    toChainId: string;

    message: string;
    messageCtx?: string;
};

export type AMBProofJSON = AMBProof;



// Relay and Bounty types
// ************************************************************************************************

export enum RelayStatus {
    BountyPlaced,
    MessageDelivered,
    BountyClaimed,
}

export interface RelayState {

    // Common fields (derived from events)
    status: RelayStatus;
    messageIdentifier: string;

    // GeneralisedIncentives specific details
    bountyPlacedEvent?: BountyPlacedEventDetails;
    messageDeliveredEvent?: MessageDeliveredEventDetails;
    bountyClaimedEvent?: BountyClaimedEventDetails;
    bountyIncreasedEvent?: BountyIncreasedEventDetails;

    // Delivery information
    deliveryGasCost?: bigint;
}

export interface BountyPlacedEventDetails extends TransactionDescription {
    fromChainId: string;
    incentivesAddress: string;

    maxGasDelivery: bigint;
    maxGasAck: bigint;
    refundGasTo: string;
    priceOfDeliveryGas: bigint;
    priceOfAckGas: bigint;
    targetDelta: bigint;
}

export interface MessageDeliveredEventDetails extends TransactionDescription {
    toChainId: string;
}

export interface BountyClaimedEventDetails extends TransactionDescription {
}

export interface BountyIncreasedEventDetails extends TransactionDescription {
    newDeliveryGasPrice: bigint;
    newAckGasPrice: bigint;
}


export interface RelayStateJSON {
    status: RelayStatus;
    messageIdentifier: string;

    bountyPlacedEvent?: BountyPlacedEventDetailsJSON;
    messageDeliveredEvent?: MessageDeliveredEventDetailsJSON;
    bountyClaimedEvent?: BountyClaimedEventDetailsJSON;
    bountyIncreasedEvent?: BountyIncreasedEventDetailsJSON;

    deliveryGasCost?: string;
}

export interface BountyPlacedEventDetailsJSON extends TransactionDescription {
    fromChainId: string;
    incentivesAddress: string;

    maxGasDelivery: string;
    maxGasAck: string;
    refundGasTo: string;
    priceOfDeliveryGas: string;
    priceOfAckGas: string;
    targetDelta: string;
}

export type MessageDeliveredEventDetailsJSON = MessageDeliveredEventDetails;

export type BountyClaimedEventDetailsJSON = BountyClaimedEventDetails;

export interface BountyIncreasedEventDetailsJSON extends TransactionDescription {
    newDeliveryGasPrice: string;
    newAckGasPrice: string;
}



// Controller Types
// ************************************************************************************************

export interface PrioritiseMessage {
    messageIdentifier: string;
    amb: string;
    sourceChainId: string;
    destinationChainId: string;
};
