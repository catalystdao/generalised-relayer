import { LoggerOptions } from 'pino';
import { MessagePort } from 'worker_threads';

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
  retryInterval: number;
  processingInterval: number;
  maxBlocks: number | null;
  wormholeChainId: WormholeChainId;
  incentivesAddress: string;
  wormholeAddress: string;
}

export interface WormholeRelayerEngineWorkerData extends WormholeConfig {}

export interface WormholeMessageSnifferWorkerData extends WormholeChainConfig {
  wormholeChainIdMap: Map<WormholeChainId, string>;
  monitorPort: MessagePort;
  loggerOptions: LoggerOptions;
}

export interface WormholeRecoveryWorkerData extends WormholeChainConfig {
  startingBlock: number;
  wormholeChainIdMap: Map<WormholeChainId, string>;
  loggerOptions: LoggerOptions;
}
