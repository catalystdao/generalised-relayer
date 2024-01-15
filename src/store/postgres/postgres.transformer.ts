import { BountyJson } from '../types/store.types';
import { bounties } from './postgres.schema';

export function bountyFromJson(
  bounty: BountyJson,
): typeof bounties.$inferInsert & {
  submitTransactionHash?: string;
  execTransactionHash?: string;
  ackTransactionHash?: string;
} {
  return {
    bountyIdentifier: bounty.messageIdentifier,
    fromChainId: bounty.fromChainId,
    toChainId: bounty.toChainId,
    maxGasDelivery: bounty.maxGasDelivery?.toString(),
    maxGasAck: bounty.maxGasAck?.toString(),
    refundGasTo: bounty.refundGasTo,
    priceOfDeliveryGas: bounty.priceOfDeliveryGas,
    priceOfAckGas: bounty.priceOfAckGas,
    targetDelta: bounty.targetDelta,
    bountyStatus: bounty.status,
    sourceAddress: bounty.sourceAddress,
    destinationAddress: bounty.destinationAddress,
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
