import { BigNumber } from 'ethers';
import { BountyStatus } from './bounty.enum';

export type AmbMessage = {
  messageIdentifier: string;
  amb: string;
  destinationChain: string;
  payload: string; // This is specifically Generalised Incentive payload.
};

export type AmbPayload = {
  messageIdentifier: string;
  amb: string;
  destinationChainId: string;
  message: string;
  messageCtx?: string;
  priority?: boolean;
};

export type Bounty = {
  messageIdentifier: string;
  fromChainId: string;
  toChainId?: string;
  maxGasDelivery: number;
  maxGasAck: number;
  refundGasTo: string;
  priceOfDeliveryGas: BigNumber;
  priceOfAckGas: BigNumber;
  targetDelta: BigNumber;
  status: BountyStatus;
  address: string;
  finalised?: boolean;
  submitTransactionHash?: string;
  execTransactionHash?: string;
  ackTransactionHash?: string;
};

export type BountyJson = {
  messageIdentifier: string;
  fromChainId?: string;
  toChainId?: string;
  maxGasDelivery?: number;
  maxGasAck?: number;
  refundGasTo?: string;
  priceOfDeliveryGas?: string;
  priceOfAckGas?: string;
  targetDelta?: string;
  status: BountyStatus;
  address?: string;
  finalised?: boolean;
  submitTransactionHash?: string;
  execTransactionHash?: string;
  ackTransactionHash?: string;
};
