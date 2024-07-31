import * as fs from 'fs';
import * as yaml from 'js-yaml';
import { getConfigValidator } from '../../src/config/config.schema';
import dotenv from 'dotenv';


//These are the default anvil keys and values, you can use any other funded keys available on both chains
const publicKey: string = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const privateKey: string = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

export let config = {
    global: {
        privateKey: privateKey,
        logLevel: 'debug',
        monitor: {
            interval: 5000,
            blockDelay: 1,
        },
        getter: {
            retryInterval: 5000,
            processingInterval: 100,
            maxBlocks: 1000,
        },
        submitter: {
            enabled: true,
            newOrdersDelay: 1000,
            retryInterval: 30000,
            processingInterval: 100,
            maxTries: 3,
            maxPendingTransactions: 50,
            evaluationRetryInterval: 3600000,
            maxEvaluationDuration: 86400000,
        },
        pricing: {
            provider: 'fixed',
            coinDecimals: 18,
            pricingDenomination: 'usd',
        },
        wallet: {
            retryInterval: 30000,
            processingInterval: 100,
            maxTries: 3,
            maxPendingTransactions: 50,
            confirmations: 1,
            confirmationTimeout: 90000,
            lowGasBalanceWarning: '1000000000000000000',
            gasBalanceUpdateInterval: 50,
            maxFeePerGas: '200000000000',
            maxAllowedPriorityFeePerGas: '100000000000',
            maxPriorityFeeAdjustmentFactor: 1.01,
            maxAllowedGasPrice: '200000000000',
            gasPriceAdjustmentFactor: 1.01,
            priorityAdjustmentFactor: 1.05,
        },
        persister: {
            enabled: false,
            postgresString: 'postgresql://username:password@location/database?sslmode=require',
        },
        evaluator: {
            unrewardedDeliveryGas: '25000',
            verificationDeliveryGas: '55000',
            minDeliveryReward: 0.001,
            relativeMinDeliveryReward: 0.001,
            unrewardedAckGas: '25000',
            verificationAckGas: '55000',
            minAckReward: 0.001,
            relativeMinAckReward: 0.001,
            profitabilityFactor: 1.0,
        },
    },
    ambs: [
        {
            name: 'mock',
            enabled: true,
            privateKey: privateKey,
        },
    ],
    chains: [
        {
            chainId: 1,
            name: 'Testnet 1',
            rpc: 'http://127.0.0.1:8545',
            monitor: {
                interval: 1000,
            },
            pricing: {
                value: 10,
            },
            mock: {
                incentivesAddress: "",
            },
        },
        {
            chainId: 2,
            name: 'Testnet 2',
            rpc: 'http://127.0.0.1:8546',
            monitor: {
                interval: 1000,
            },
            pricing: {
                value: 10,
            },
            mock: {
                incentivesAddress: "",
            },
        },
    ],
};



export let deploymentConfig = {
    publicKey: publicKey,
    privateKey: privateKey,
    catalystVault: "0xd8058efe0198ae9dD7D563e1b4938Dcbc86A1F81",
};

export const generateConfig = (escrowAddress: string, catalystVault: string) => {
    config.chains.forEach(chain => {
        chain.mock.incentivesAddress = escrowAddress;
    });

    deploymentConfig = {
        publicKey: publicKey,
        privateKey: privateKey,
        catalystVault: catalystVault,
    };
    createYaml('./tests/config/config.test.yaml');
};

const createYaml = (filePath: string): void => {

    try {
        const combinedConfig = {
            global: config.global,
            ambs: config.ambs,
            chains: config.chains,
        };

        const validate = getConfigValidator();
        if (!validate(combinedConfig)) {
            throw new Error('Configuration validation failed: ' + JSON.stringify(validate.errors));
        }

        const yamlStr = yaml.dump(combinedConfig, {
            lineWidth: -1,
            noRefs: true,
        });

        fs.writeFileSync(filePath, yamlStr, 'utf8');
        console.log(`File ${filePath} created successfully.`);
    } catch (error) {
        throw new Error('Error creating config file: ${error}' + error);
    }
};
export const loadConfig = (filePath: string): any => {
    try {
        const fileContent = fs.readFileSync(filePath, 'utf8');
        const loadedConfig = yaml.load(fileContent);

        Object.assign(config, loadedConfig);
        return loadedConfig;
    } catch (error) {
        throw new Error(`Error loading config file: ${error}`);
    }
};


// Load environment variables from .env file
dotenv.config();

const ATTEMPTS_MAXIMUM: number = process.env['ATTEMPTS_MAXIMUM'] ? parseInt(process.env['ATTEMPTS_MAXIMUM']) : 10;
const TIME_BETWEEN_ATTEMPTS: number = process.env['TIME_BETWEEN_ATTEMPTS'] ? parseInt(process.env['TIME_BETWEEN_ATTEMPTS']) : 1000;

export { ATTEMPTS_MAXIMUM, TIME_BETWEEN_ATTEMPTS };
