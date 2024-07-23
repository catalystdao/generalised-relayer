import { RelayStateJSON } from '../store.types';
import { bounties } from './postgres.schema';

export function bountyFromJson(
    bounty: RelayStateJSON,
): typeof bounties.$inferInsert & {
    submitTransactionHash?: string;
    execTransactionHash?: string;
    ackTransactionHash?: string;
} {
    return {
        bountyIdentifier: bounty.messageIdentifier,

        fromChainId: bounty.bountyPlacedEvent?.fromChainId,
        toChainId: bounty.messageDeliveredEvent?.toChainId,

        maxGasDelivery: bounty.bountyPlacedEvent?.maxGasDelivery?.toString(),
        maxGasAck: bounty.bountyPlacedEvent?.maxGasAck?.toString(),
        refundGasTo: bounty.bountyPlacedEvent?.refundGasTo,
        priceOfDeliveryGas: bounty.bountyIncreasedEvent?.newDeliveryGasPrice
            ?? bounty.bountyPlacedEvent?.priceOfDeliveryGas,
        priceOfAckGas: bounty.bountyIncreasedEvent?.newAckGasPrice
            ?? bounty.bountyPlacedEvent?.priceOfAckGas,
        targetDelta: bounty.bountyPlacedEvent?.targetDelta,

        bountyStatus: bounty.status,

        sourceAddress: bounty.bountyPlacedEvent?.incentivesAddress,
    };
}

// export function proofFromJson(proof: AmbPayload): typeof ambPayloads.$inferInsert &  {bountyIdentifier: string} {
//   return {
//     bountyId: -1, // This is not a valid bountyId. It needs to be collected from the storage first using the bounty identifier.
//     bountyIdentifier: proof.messageIdentifier,
//     amb: proof.amb,
//     destinationChain: proof.destinationChainId,
//     message: proof.message,
//     messageCtx: proof.messageCtx,
//   }
// }
