import { Injectable } from '@nestjs/common';
import { readFileSync } from 'fs';
import * as yaml from 'js-yaml';
import dotenv from 'dotenv';
import { PRICING_SCHEMA, getConfigValidator } from './config.schema';
import { GlobalConfig, ChainConfig, AMBConfig, GetterGlobalConfig, SubmitterGlobalConfig, PersisterConfig, WalletGlobalConfig, GetterConfig, SubmitterConfig, WalletConfig, MonitorConfig, MonitorGlobalConfig, PricingGlobalConfig, EvaluatorGlobalConfig, PricingConfig, EvaluatorConfig } from './config.types';
import { JsonRpcProvider } from 'ethers6';
import { loadPrivateKeyLoader } from './privateKeyLoaders/privateKeyLoader';

@Injectable()
export class ConfigService {
    private readonly rawConfig: Record<string, any>;

    readonly nodeEnv: string;

    readonly globalConfig: GlobalConfig;
    readonly chainsConfig: Map<string, ChainConfig>;
    readonly ambsConfig: Map<string, AMBConfig>;

    readonly isReady: Promise<void>;

    constructor() {
        this.nodeEnv = this.loadNodeEnv();

        this.loadEnvFile();
        this.rawConfig = this.loadConfigFile();

        this.globalConfig = this.loadGlobalConfig();
        this.chainsConfig = this.loadChainsConfig();
        this.ambsConfig = this.loadAMBsConfig();

        this.isReady = this.initialize();
    }


    // NOTE: The OnModuleInit hook is not being used as it does not guarantee the order in which it
    // is executed across services (i.e. there is no guarantee that the config service will be the
    // first to initialize). The `isReady` promise must be awaited on Relayer initialization.
    private async initialize(): Promise<void> {
        await this.validateChainIds(this.chainsConfig);
    }

    private loadNodeEnv(): string {
        const nodeEnv = process.env['NODE_ENV'];

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
        const configFilePath = process.env['CONFIG_FILE_PATH'];
        const configFileName = configFilePath || `config.${this.nodeEnv}.yaml`;

        let rawConfig;
        try {
            rawConfig = readFileSync(configFileName, 'utf-8');
        } catch (error: any) {
            throw new Error(
                'Unable to load the relayer configuration file ${configFileName}. Cause: ' +
                error?.message,
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

    private async loadPrivateKey(rawPrivateKeyConfig: any): Promise<string> {
        if (typeof rawPrivateKeyConfig === "string") {
            //NOTE: Using 'console.warn' as the logger is not available at this point.  //TODO use logger
            console.warn('WARNING: the privateKey has been loaded from the configuration file. Consider storing the privateKey using an alternative safer method.')
            return rawPrivateKeyConfig;
        }

        const privateKeyLoader = loadPrivateKeyLoader(
            rawPrivateKeyConfig?.['loader'] ?? null,
            rawPrivateKeyConfig ?? {},
        );

        return privateKeyLoader.load();
    }

    private loadGlobalConfig(): GlobalConfig {
        const rawGlobalConfig = this.rawConfig['global'];

        if (process.env['RELAYER_PORT'] == undefined) {
            throw new Error(
                "Invalid configuration: environment variable 'RELAYER_PORT' missing",
            );
        }

        return {
            port: parseInt(process.env['RELAYER_PORT']),
            privateKey: this.loadPrivateKey(rawGlobalConfig.privateKey),
            logLevel: rawGlobalConfig.logLevel,
            monitor: this.formatMonitorGlobalConfig(rawGlobalConfig.monitor),
            getter: this.formatGetterGlobalConfig(rawGlobalConfig.getter),
            pricing: this.formatPricingGlobalConfig(rawGlobalConfig.pricing),
            evaluator: this.formatEvaluatorGlobalConfig(rawGlobalConfig.evaluator),
            submitter: this.formatSubmitterGlobalConfig(rawGlobalConfig.submitter),
            persister: this.formatPersisterGlobalConfig(rawGlobalConfig.persister),
            wallet: this.formatWalletGlobalConfig(rawGlobalConfig.wallet),
        };
    }

    private loadChainsConfig(): Map<string, ChainConfig> {
        const chainConfig = new Map<string, ChainConfig>();

        for (const rawChainConfig of this.rawConfig['chains']) {
            const chainId = rawChainConfig.chainId.toString();
            chainConfig.set(chainId, {
                chainId,
                name: rawChainConfig.name,
                rpc: rawChainConfig.rpc,
                resolver: rawChainConfig.resolver ?? null,
                startingBlock: rawChainConfig.startingBlock,
                stoppingBlock: rawChainConfig.stoppingBlock,
                monitor: this.formatMonitorConfig(rawChainConfig.monitor),
                getter: this.formatGetterConfig(rawChainConfig.getter),
                pricing: this.formatPricingConfig(rawChainConfig.pricing),
                evaluator: this.formatEvaluatorConfig(rawChainConfig.evaluator),
                submitter: this.formatSubmitterConfig(rawChainConfig.submitter),
                wallet: this.formatWalletConfig(rawChainConfig.wallet),
            });
        }

        return chainConfig;
    }

    private loadAMBsConfig(): Map<string, AMBConfig> {
        const ambConfig = new Map<string, AMBConfig>();

        for (const rawAMBConfig of this.rawConfig['ambs']) {
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
            const chainOverride = this.rawConfig['chains'].find(
                (rawChainConfig: any) => rawChainConfig.chainId.toString() == chainId,
            )?.[amb]?.[key];

            if (chainOverride != undefined) return chainOverride;
        }

        // If there is no chain-specific override, return the default value for the property.
        return this.ambsConfig.get(amb)?.globalProperties[key];
    }

    private async validateChainIds(chainsConfig: Map<string, ChainConfig>): Promise<void> {

        const validationPromises = [];
        for (const [chainId, config] of chainsConfig) {
            const provider = new JsonRpcProvider(config.rpc, undefined, { staticNetwork: true });
            const validationPromise = provider.getNetwork().then(
                (network) => {
                    const rpcChainId = network.chainId.toString();
                    if (rpcChainId !== chainId) {
                        throw new Error(`Error validating the chain ID of chain ${chainId}: the RPC chain ID is ${rpcChainId}.`)
                    }
                }
            )
            validationPromises.push(validationPromise);
        }

        await Promise.all(validationPromises);
    }



    // Formatting helpers
    // ********************************************************************************************

    private formatMonitorGlobalConfig(rawConfig: any): MonitorGlobalConfig {
        return { ...rawConfig } as MonitorGlobalConfig;
    }

    private formatGetterGlobalConfig(rawConfig: any): GetterGlobalConfig {
        return { ...rawConfig } as GetterGlobalConfig;
    }

    private formatPricingGlobalConfig(rawConfig: any): PricingGlobalConfig {
        const commonKeys = Object.keys(PRICING_SCHEMA.properties);

        const formattedConfig: Record<string, any> = {};
        formattedConfig['providerSpecificConfig'] = {}

        // Any configuration keys that do not form part of the 'PRICING_SCHEMA' definition are
        // assumed to be provider-specific configuration options.
        for (const [key, value] of Object.entries(rawConfig ?? {})) {
            if (commonKeys.includes(key)) {
                formattedConfig[key] = value;
            }
            else {
                formattedConfig['providerSpecificConfig'][key] = value;
            }
        }

        return formattedConfig as PricingGlobalConfig;
    }

    private formatEvaluatorGlobalConfig(rawConfig: any): EvaluatorGlobalConfig {
        const config = { ...rawConfig };
        if (config.unrewardedDeliveryGas != undefined) {
            config.unrewardedDeliveryGas = BigInt(config.unrewardedDeliveryGas);
        }
        if (config.verificationDeliveryGas != undefined) {
            config.verificationDeliveryGas = BigInt(config.verificationDeliveryGas);
        }
        if (config.unrewardedAckGas != undefined) {
            config.unrewardedAckGas = BigInt(config.unrewardedAckGas);
        }
        if (config.verificationAckGas != undefined) {
            config.verificationAckGas = BigInt(config.verificationAckGas);
        }
        return config as EvaluatorGlobalConfig;
    }

    private formatSubmitterGlobalConfig(rawConfig: any): SubmitterGlobalConfig {
        return { ...rawConfig } as SubmitterGlobalConfig;
    }

    private formatPersisterGlobalConfig(rawConfig: any): PersisterConfig {
        return { ...rawConfig } as PersisterConfig;
    }

    private formatWalletGlobalConfig(rawConfig: any): WalletGlobalConfig {
        const config = { ...rawConfig };
        if (config.lowGasBalanceWarning != undefined) {
            config.lowGasBalanceWarning = BigInt(config.lowGasBalanceWarning);
        }
        if (config.maxFeePerGas != undefined) {
            config.maxFeePerGas = BigInt(config.maxFeePerGas);
        }
        if (config.maxAllowedPriorityFeePerGas != undefined) {
            config.maxAllowedPriorityFeePerGas = BigInt(config.maxAllowedPriorityFeePerGas);
        }
        if (config.maxAllowedGasPrice != undefined) {
            config.maxAllowedGasPrice = BigInt(config.maxAllowedGasPrice);
        }
        return config as WalletGlobalConfig;
    }


    private formatMonitorConfig(rawConfig: any): MonitorConfig {
        return this.formatMonitorGlobalConfig(rawConfig);
    }

    private formatGetterConfig(rawConfig: any): GetterConfig {
        return this.formatGetterGlobalConfig(rawConfig);
    }

    private formatPricingConfig(rawConfig: any): PricingConfig {
        return this.formatPricingGlobalConfig(rawConfig);
    }

    private formatEvaluatorConfig(rawConfig: any): EvaluatorConfig {
        return this.formatEvaluatorGlobalConfig(rawConfig);
    }

    private formatSubmitterConfig(rawConfig: any): SubmitterConfig {
        return this.formatSubmitterGlobalConfig(rawConfig);
    }

    private formatWalletConfig(rawConfig: any): WalletConfig {
        return this.formatWalletGlobalConfig(rawConfig);
    }

}
