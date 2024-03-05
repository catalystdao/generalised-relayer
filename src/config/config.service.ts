import { Injectable } from '@nestjs/common';
import { readFileSync } from 'fs';
import * as yaml from 'js-yaml';
import dotenv from 'dotenv';
import { getConfigValidator } from './config-schemas';
import { GlobalConfig, ChainConfig, AMBConfig } from './config.types';

@Injectable()
export class ConfigService {
  private readonly rawConfig: Record<string, any>;

  readonly nodeEnv: string;

  readonly globalConfig: GlobalConfig;
  readonly chainsConfig: Map<string, ChainConfig>;
  readonly ambsConfig: Map<string, AMBConfig>;

  constructor() {
    this.nodeEnv = this.loadNodeEnv();

    this.loadEnvFile();
    this.rawConfig = this.loadConfigFile();

    this.globalConfig = this.loadGlobalConfig();
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

    const config = yaml.load(rawConfig) as Record<string, any>;

    this.validateConfig(config);
    return config;
  }

  private validateConfig(config: any): void {
    const validator = getConfigValidator();
    const isConfigValid = validator(config);

    if (!isConfigValid) {
      const error = validator.errors;
      console.error('Config validation failed:', error);
      throw new Error('Config validation failed.');
    }
  }

  private loadGlobalConfig(): GlobalConfig {
    const rawGlobalConfig = this.rawConfig.global;

    if (process.env.RELAYER_PORT == undefined) {
      throw new Error(
        "Invalid configuration: environment variable 'RELAYER_PORT' missing",
      );
    }

    return {
      port: parseInt(process.env.RELAYER_PORT),
      privateKey: rawGlobalConfig.privateKey,
      logLevel: rawGlobalConfig.logLevel,
      blockDelay: rawGlobalConfig.blockDelay,
      getter: rawGlobalConfig.getter ?? {},
      submitter: rawGlobalConfig.submitter ?? {},
      persister: rawGlobalConfig.persister ?? {},
    };
  }

  private loadChainsConfig(): Map<string, ChainConfig> {
    const chainConfig = new Map<string, ChainConfig>();

    for (const rawChainConfig of this.rawConfig.chains) {
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

  private loadAMBsConfig(): Map<string, AMBConfig> {
    const ambConfig = new Map<string, AMBConfig>();

    for (const rawAMBConfig of this.rawConfig.ambs) {
      if (rawAMBConfig.enabled == false) {
        continue;
      }

      const ambName = rawAMBConfig.name;
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
