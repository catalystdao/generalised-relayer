export interface GlobalConfig {
  port: number;
  privateKey: string;
  logLevel?: string;
  blockDelay?: number;
  getter: GetterGlobalConfig;
  submitter: SubmitterGlobalConfig;
  persister: PersisterConfig;
  wallet: WalletGlobalConfig;
}

export interface GetterGlobalConfig {
  interval?: number;
  maxBlocks?: number;
}

export interface GetterConfig extends GetterGlobalConfig {}

export interface SubmitterGlobalConfig {
  enabled?: boolean;
  newOrdersDelay?: number;
  retryInterval?: number;
  processingInterval?: number;
  maxTries?: number;
  maxPendingTransactions?: number;

  gasLimitBuffer?: Record<string, number> & { default?: number };
}

export interface SubmitterConfig extends SubmitterGlobalConfig {}

export interface PersisterConfig {
  enabled: boolean;
  postgresString: string;
}

export interface WalletGlobalConfig {
  retryInterval?: number;
  processingInterval?: number;
  maxTries?: number;
  maxPendingTransactions?: number;
  confirmations?: number;
  confirmationTimeout?: number;
  lowGasBalanceWarning?: bigint;
  gasBalanceUpdateInterval?: number;
  maxFeePerGas?: bigint;
  maxAllowedPriorityFeePerGas?: bigint;
  maxPriorityFeeAdjustmentFactor?: number;
  maxAllowedGasPrice?: bigint;
  gasPriceAdjustmentFactor?: number;
  priorityAdjustmentFactor?: number;
}

export interface WalletConfig extends WalletGlobalConfig {
  rpc?: string;
}

export interface AMBConfig {
  name: string;
  globalProperties: Record<string, any>;
  getIncentivesAddress: (chainId: string) => string;
}

export interface ChainConfig {
  chainId: string;
  name: string;
  rpc: string;
  startingBlock?: number;
  stoppingBlock?: number;
  blockDelay?: number;
  getter: GetterConfig;
  submitter: SubmitterConfig;
  wallet: WalletConfig;
}
