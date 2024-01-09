import { BytesLike } from 'ethers';

export interface WormholeInfo {
  messageIdentifier: string;
  destinationChainId: string;
  rawMessage: BytesLike;
}
