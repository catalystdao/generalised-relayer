import { Injectable } from '@nestjs/common';
import { readFileSync } from 'fs';
import * as yaml from 'js-yaml';
import dotenv from 'dotenv';

export interface RelayerConfig {
  port: number;
  privateKey: string;
  logLevel?: string;
  blockDelay?: number;
  getter: GetterGlobalConfig;
  submitter: SubmitterGlobalConfig;
  persister: PersisterConfig;
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
}

export interface AMBConfig {
  name: string;
  globalProperties: Record<string, any>;
  getIncentivesAddress: (chainId: string) => string;
}

export interface GetterGlobalConfig {
  interval?: number;
  maxBlocks?: number;
}

export interface GetterConfig extends GetterGlobalConfig {}

export interface SubmitterGlobalConfig {
  enabled?: boolean;
  newOrdersDelay: number;
  retryInterval?: number;
  processingInterval?: number;
  maxTries?: number;
  maxPendingTransactions?: number;
  transactionTimeout?: number;
  gasLimitBuffer?: Record<string, number> & { default?: number }; //TODO 'gasLimitBuffer' should only be applied on a per-chain basis (like the other gas-related config)
}

export interface SubmitterConfig extends SubmitterGlobalConfig {
  maxFeePerGas?: number;
  maxPriorityFeeAdjustmentFactor?: number;
  maxAllowedPriorityFeePerGas?: number;
  gasPriceAdjustmentFactor?: number;
  maxAllowedGasPrice?: number;
}

export interface PersisterConfig {
  enabled: boolean;
  postgresString: string;
}

//TODO config schema verification should not be implemented manually.

@Injectable()
export class ConfigService {
  private readonly rawConfig: Record<string, any>;

  readonly nodeEnv: string;

  readonly relayerConfig: RelayerConfig;
  readonly chainsConfig: Map<string, ChainConfig>;
  readonly ambsConfig: Map<string, AMBConfig>;

  constructor() {
    this.nodeEnv = this.loadNodeEnv();

    this.loadEnvFile();
    this.rawConfig = this.loadConfigFile();

    this.relayerConfig = this.loadRelayerConfig();
    this.chainsConfig = this.loadChainsConfig();
    this.ambsConfig = this.loadAMBsConfig();
  }

  private loadNodeEnv(): string {
    const nodeEnv = process.env.NODE_ENV;

    if (nodeEnv == undefined) {
      throw new Error(
        'Unable to load the relayer configuration, `NODE_ENV` environment variable is not set.',
      );
    }

    return nodeEnv;
  }

  private loadEnvFile(): void {
    dotenv.config();
  }

  private loadConfigFile(): Record<string, any> {
    const configFileName = `config.${this.nodeEnv}.yaml`;

    let rawConfig;
    try {
      rawConfig = readFileSync(configFileName, 'utf-8');
    } catch (error) {
      throw new Error(
        'Unable to load the relayer configuration file ${configFileName}. Cause: ' +
          error.message,
      );
    }

    return yaml.load(rawConfig) as Record<string, any>;
  }

  private loadRelayerConfig(): RelayerConfig {
    const rawRelayerConfig = this.rawConfig.relayer;
    if (rawRelayerConfig == undefined) {
      throw new Error(
        "'relayer' configuration missing on the configuration file",
      );
    }

    if (process.env.RELAYER_PORT == undefined) {
      throw new Error(
        "Invalid relayer configuration: environment variable 'RELAYER_PORT' missing",
      );
    }

    if (rawRelayerConfig.privateKey == undefined) {
      throw new Error("Invalid relayer configuration: 'privateKey' missing.");
    }

    return {
      port: parseInt(process.env.RELAYER_PORT),
      privateKey: rawRelayerConfig.privateKey,
      logLevel: rawRelayerConfig.logLevel,
      blockDelay: rawRelayerConfig.blockDelay,
      getter: rawRelayerConfig.getter ?? {},
      submitter: rawRelayerConfig.submitter ?? {},
      persister: rawRelayerConfig.persister ?? {},
    };
  }

  private loadChainsConfig(): Map<string, ChainConfig> {
    const chainConfig = new Map<string, ChainConfig>();

    for (const rawChainConfig of this.rawConfig.chains) {
      if (rawChainConfig.chainId == undefined) {
        throw new Error(`Invalid chain configuration: 'chainId' missing.`);
      }
      if (rawChainConfig.name == undefined) {
        throw new Error(
          `Invalid chain configuration for chain '${rawChainConfig.chainId}': 'name' missing.`,
        );
      }
      if (rawChainConfig.rpc == undefined) {
        throw new Error(
          `Invalid chain configuration for chain '${rawChainConfig.chainId}': 'rpc' missing.`,
        );
      }
      chainConfig.set(rawChainConfig.chainId, {
        chainId: rawChainConfig.chainId.toString(),
        name: rawChainConfig.name,
        rpc: rawChainConfig.rpc,
        startingBlock: rawChainConfig.startingBlock,
        stoppingBlock: rawChainConfig.stoppingBlock,
        blockDelay: rawChainConfig.blockDelay,
        getter: rawChainConfig.getter ?? {},
        submitter: rawChainConfig.submitter ?? {},
      });
    }

    return chainConfig;
  }

  //TODO refactor where the 'amb' config is set (do the same as with the underwriter)
  private loadAMBsConfig(): Map<string, AMBConfig> {
    const ambConfig = new Map<string, AMBConfig>();

    for (const ambName of this.rawConfig.ambs) {
      const rawAMBConfig = this.rawConfig[ambName];

      if (rawAMBConfig == undefined) {
        throw new Error(`No configuration set for amb '${ambName}'`);
      }
      if (rawAMBConfig.incentivesAddress == undefined) {
        throw new Error(
          `Invalid AMB configuration for AMB '${ambName}': 'incentivesAddress' missing.`,
        );
      }

      const globalProperties = rawAMBConfig;

      ambConfig.set(ambName, {
        name: ambName,
        globalProperties,
        getIncentivesAddress: (chainId: string) => {
          return this.getAMBConfig(ambName, 'incentivesAddress', chainId);
        },
      });
    }

    return ambConfig;
  }

  getAMBConfig<T = unknown>(amb: string, key: string, chainId?: string): T {
    // Find if there is a chain-specific override for the AMB property.
    if (chainId != undefined) {
      const chainOverride = this.rawConfig.chains.find(
        (rawChainConfig: any) => rawChainConfig.chainId == chainId,
      )?.[amb]?.[key];

      if (chainOverride != undefined) return chainOverride;
    }

    // If there is no chain-specific override, return the default value for the property.
    return this.ambsConfig.get(amb)?.globalProperties[key];
  }
}
