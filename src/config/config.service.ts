import { Injectable } from '@nestjs/common';
import { readFileSync } from 'fs';
import * as yaml from 'js-yaml';
import dotenv from 'dotenv';
import { getConfigValidator } from './config.schema';
import { GlobalConfig, ChainConfig, AMBConfig, GetterGlobalConfig, SubmitterGlobalConfig, PersisterConfig, WalletGlobalConfig, GetterConfig, SubmitterConfig, WalletConfig, MonitorConfig, MonitorGlobalConfig } from './config.types';
import { HttpService } from '@nestjs/axios';
import { AxiosResponse } from 'axios';
import { lastValueFrom } from 'rxjs';

@Injectable()
export class ConfigService {
    private readonly rawConfig: Record<string, any>;

    readonly nodeEnv: string;

    readonly globalConfig: GlobalConfig;
    readonly chainsConfig: Map<string, ChainConfig>;
    readonly ambsConfig: Map<string, AMBConfig>;

    constructor(private readonly httpService: HttpService) {
        this.nodeEnv = this.loadNodeEnv();

        this.loadEnvFile();
        this.rawConfig = this.loadConfigFile();

        this.globalConfig = this.loadGlobalConfig();
        this.chainsConfig = this.loadChainsConfig();
        this.ambsConfig = this.loadAMBsConfig();

        this.verifyChainIds();
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
        const configFileName = `config.${this.nodeEnv}.yaml`;

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

    private loadGlobalConfig(): GlobalConfig {
        const rawGlobalConfig = this.rawConfig['global'];

        if (process.env['RELAYER_PORT'] == undefined) {
            throw new Error(
                "Invalid configuration: environment variable 'RELAYER_PORT' missing",
            );
        }

        return {
            port: parseInt(process.env['RELAYER_PORT']),
            privateKey: rawGlobalConfig.privateKey,
            logLevel: rawGlobalConfig.logLevel,
            monitor: this.formatMonitorGlobalConfig(rawGlobalConfig.monitor),
            getter: this.formatGetterGlobalConfig(rawGlobalConfig.getter),
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

    private async verifyChainIds(): Promise<void> {
        for (const [chainId, chainConfig] of this.chainsConfig.entries()) {
            const rpcChainId = await this.getChainIdFromRpc(chainConfig.rpc);
            if (rpcChainId !== parseInt(chainId)) {
                throw new Error(`Chain ID mismatch for ${chainConfig.name}. Expected: ${chainId}, Got: ${rpcChainId}`);
            }
        }
    }

    private async getChainIdFromRpc(rpcUrl: string): Promise<number> {
        const response: AxiosResponse<any> = await lastValueFrom(this.httpService.post(rpcUrl, {
            jsonrpc: '2.0',
            method: 'eth_chainId',
            params: [],
            id: 1,
        }));

        return parseInt(response.data.result, 16);
    }

    // Formatting helpers
    // ********************************************************************************************

    private formatMonitorGlobalConfig(rawConfig: any): MonitorGlobalConfig {
        return { ...rawConfig } as MonitorGlobalConfig;
    }

    private formatGetterGlobalConfig(rawConfig: any): GetterGlobalConfig {
        return { ...rawConfig } as GetterGlobalConfig;
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

    private formatSubmitterConfig(rawConfig: any): SubmitterConfig {
        return this.formatSubmitterGlobalConfig(rawConfig);
    }

    private formatWalletConfig(rawConfig: any): WalletConfig {
        return this.formatWalletGlobalConfig(rawConfig);
    }
}
