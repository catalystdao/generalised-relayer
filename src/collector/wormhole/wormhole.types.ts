import { LoggerOptions } from 'pino';

export type WormholeChainId = number;

export interface WormholeConfig {
  isTestnet: boolean;
  useDocker: boolean;
  spyPort: string;
  wormholeChainConfigs: Map<string, WormholeChainConfig>;
  wormholeChainIdMap: Map<WormholeChainId, string>;
  loggerOptions: LoggerOptions;
}

export interface WormholeChainConfig {
  chainId: string;
  rpc: string;
  startingBlock?: number;
  stoppingBlock?: number;
  blockDelay: number;
  interval: number;
  maxBlocks: number | null;
  wormholeChainId: WormholeChainId;
  incentivesAddress: string;
  wormholeAddress: string;
}

export interface WormholeRelayerEngineWorkerData extends WormholeConfig {}

export interface WormholeMessageSnifferWorkerData extends WormholeChainConfig {
  wormholeChainIdMap: Map<WormholeChainId, string>;
  loggerOptions: LoggerOptions;
}

export interface WormholeRecoveryWorkerData extends WormholeChainConfig {
  startingBlock: number;
  wormholeChainIdMap: Map<WormholeChainId, string>;
  loggerOptions: LoggerOptions;
}
