export interface GlobalConfig {
  port: number;
  privateKey: Promise<string>;
  logLevel?: string;
  monitor: MonitorGlobalConfig;
  getter: GetterGlobalConfig;
  pricing: PricingGlobalConfig;
  evaluator: EvaluatorGlobalConfig;
  submitter: SubmitterGlobalConfig;
  persister: PersisterConfig;
  wallet: WalletGlobalConfig;
}

export type PrivateKeyConfig = string | {
  loader: string;
}

export interface MonitorGlobalConfig {
  interval?: number;
  blockDelay?: number;
  noBlockUpdateWarningInterval?: number;
}

export interface MonitorConfig extends MonitorGlobalConfig {}

export interface GetterGlobalConfig {
  retryInterval?: number;
  processingInterval?: number;
  maxBlocks?: number;
}

export interface GetterConfig extends GetterGlobalConfig {}

export interface PricingGlobalConfig {
  provider?: string;
  coinDecimals?: number;
  pricingDenomination?: string;
  cacheDuration?: number;
  retryInterval?: number;
  maxTries?: number;
  providerSpecificConfig: Record<string, any>;
};

export interface PricingConfig extends PricingGlobalConfig {}

export interface EvaluatorGlobalConfig {
  unrewardedDeliveryGas?: bigint;
  verificationDeliveryGas?: bigint;
  minDeliveryReward?: number;
  relativeMinDeliveryReward?: number;
  unrewardedAckGas?: bigint;
  verificationAckGas?: bigint;
  minAckReward?: number;
  relativeMinAckReward?: number;
  profitabilityFactor?: number;
}

export interface EvaluatorConfig extends EvaluatorGlobalConfig {}

export interface SubmitterGlobalConfig {
  enabled?: boolean;
  newOrdersDelay?: number;
  retryInterval?: number;
  processingInterval?: number;
  maxTries?: number;
  maxPendingTransactions?: number;

  evaluationRetryInterval?: number;
  maxEvaluationDuration?: number;
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
  resolver: string | null;
  startingBlock?: number;
  stoppingBlock?: number;
  monitor: MonitorConfig;
  getter: GetterConfig;
  pricing: PricingConfig;
  evaluator: EvaluatorConfig;
  submitter: SubmitterConfig;
  wallet: WalletConfig;
}
