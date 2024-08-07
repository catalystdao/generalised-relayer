import Ajv from "ajv"
import { AnyValidateFunction } from "ajv/dist/core"

const MIN_PROCESSING_INTERVAL = 1;
const MAX_PROCESSING_INTERVAL = 500;

export const EVM_ADDRESS_EXPR = '^0x[0-9a-fA-F]{40}$';  // '0x' + 20 bytes (40 chars)
export const BYTES_32_HEX_EXPR = '^0x[0-9a-fA-F]{64}$';  // '0x' + 32 bytes (64 chars)

const POSITIVE_NUMBER_SCHEMA = {
    $id: "positive-number-schema",
    type: "number",
    minimum: 0,
}

const INTEGER_SCHEMA = {
    $id: "integer-schema",
    type: "number",
    multipleOf: 1,
}

const POSITIVE_NON_ZERO_INTEGER_SCHEMA = {
    $id: "positive-non-zero-integer-schema",
    type: "number",
    exclusiveMinimum: 0,
    multipleOf: 1,
}

const NON_EMPTY_STRING_SCHEMA = {
    $id: "non-empty-string-schema",
    type: "string",
    minLength: 1,
}

const ADDRESS_FIELD_SCHEMA = {
    $id: "address-field-schema",
    type: "string",
    pattern: EVM_ADDRESS_EXPR
}

const GAS_FIELD_SCHEMA = {
    $id: "gas-field-schema",
    type: "string",
    minLength: 1,
}

const CHAIN_ID_SCHEMA = {
    $id: "chain-id-schema",
    type: "number",
    minimum: 0
}

const PROCESSING_INTERVAL_SCHEMA = {
    $id: "processing-interval-schema",
    type: "number",
    minimum: MIN_PROCESSING_INTERVAL,
    maximum: MAX_PROCESSING_INTERVAL,
}

const CONFIG_SCHEMA = {
    $id: "config-schema",
    type: "object",
    properties: {
        global: { $ref: "global-schema" },
        ambs: { $ref: "ambs-schema" },
        chains: { $ref: "chains-schema" },
    },
    required: ["global", "ambs", "chains"],
    additionalProperties: false
}

const GLOBAL_SCHEMA = {
    $id: "global-schema",
    type: "object",
    properties: {
        privateKey: { $ref: "private-key-schema" },
        logLevel: { $ref: "non-empty-string-schema" },

        monitor: { $ref: "monitor-schema" },
        getter: { $ref: "getter-schema" },
        pricing: { $ref: "pricing-schema" },
        evaluator: { $ref: "evaluator-schema" },
        submitter: { $ref: "submitter-schema" },
        persister: { $ref: "persister-schema" },
        wallet: { $ref: "wallet-schema" },
    },
    required: [],
    additionalProperties: false
}

const PRIVATE_KEY_SCHEMA = {
    $id: "private-key-schema",
    "anyOf": [
        {
            type: "string",
            pattern: BYTES_32_HEX_EXPR,
        },
        {
            type: "object",
            properties: {
                loader: { $ref: "non-empty-string-schema" },
            },
            required: ["loader"],
            additionalProperties: true,
        }
    ]
}

const MONITOR_SCHEMA = {
    $id: "monitor-schema",
    type: "object",
    properties: {
        interval: {
            type: "number",
            minimum: 0,
            maximum: 120_000,   // 2 minutes
        },
        blockDelay: { $ref: "positive-number-schema" },
        noBlockUpdateWarningInterval: { $ref: "positive-number-schema"},
    },
    additionalProperties: false
}

const GETTER_SCHEMA = {
    $id: "getter-schema",
    type: "object",
    properties: {
        retryInterval: { $ref: "positive-number-schema" },
        processingInterval: { $ref: "processing-interval-schema" },
        maxBlocks: {
            type: "number",
            minimum: 0,
            maximum: 1_000_000,
        }
    },
    additionalProperties: false
}

export const PRICING_SCHEMA = {
    $id: "pricing-schema",
    type: "object",
    properties: {
        provider: { $ref: "non-empty-string-schema" },
        coinDecimals: { $ref: "positive-non-zero-integer-schema" },
        pricingDenomination: { $ref: "non-empty-string-schema" },
        cacheDuration: { $ref: "positive-number-schema" },
        retryInterval: { $ref: "positive-number-schema" },
        maxTries: { $ref: "positive-non-zero-integer-schema" },
    },
    additionalProperties: true  // Allow for provider-specific configurations
}

const EVALUATOR_SCHEMA = {
    $id: "evaluator-schema",
    type: "object",
    properties: {
        unrewardedDeliveryGas: { $ref: "gas-field-schema" },
        verificationDeliveryGas: { $ref: "gas-field-schema" },
        minDeliveryReward: { $ref: "positive-number-schema" },
        relativeMinDeliveryReward: { $ref: "positive-number-schema" },
        unrewardedAckGas: { $ref: "gas-field-schema" },
        verificationAckGas: { $ref: "gas-field-schema" },
        minAckReward: { $ref: "positive-number-schema" },
        relativeMinAckReward: { $ref: "positive-number-schema" },
        profitabilityFactor: { $ref: "positive-number-schema" },
    },
    additionalProperties: false
}

const SUBMITTER_SCHEMA = {
    $id: "submitter-schema",
    type: "object",
    properties: {
        enabled: {
            type: "boolean"
        },
        newOrdersDelay: { $ref: "positive-number-schema" },
        retryInterval: { $ref: "positive-number-schema" },
        processingInterval: { $ref: "processing-interval-schema" },
        maxTries: { $ref: "positive-number-schema" },
        maxPendingTransactions: { $ref: "positive-number-schema" },

        evaluationRetryInterval: { $ref: "positive-number-schema" },
        maxEvaluationDuration: { $ref: "positive-number-schema" },
    },
    additionalProperties: false
}

const PERSISTER_SCHEMA = {
    $id: "persister-schema",
    type: "object",
    properties: {
        enabled: {
            type: "boolean"
        },
        postgresString: { $ref: "non-empty-string-schema" }
    },
    additionalProperties: false
}

const WALLET_SCHEMA = {
    $id: "wallet-schema",
    type: "object",
    properties: {
        retryInterval: { $ref: "positive-number-schema" },
        processingInterval: { $ref: "processing-interval-schema" },
        maxTries: { $ref: "positive-number-schema" },
        maxPendingTransactions: { $ref: "positive-number-schema" },
        confirmations: { $ref: "positive-non-zero-integer-schema" },
        confirmationTimeout: { $ref: "positive-number-schema" },
        lowGasBalanceWarning: { $ref: "gas-field-schema" },
        gasBalanceUpdateInterval: { $ref: "positive-number-schema" },
        maxFeePerGas: { $ref: "gas-field-schema" },
        maxAllowedPriorityFeePerGas: { $ref: "gas-field-schema" },
        maxPriorityFeeAdjustmentFactor: {
            type: "number",
            minimum: 0,
            maximum: 100
        },
        maxAllowedGasPrice: { $ref: "gas-field-schema" },
        gasPriceAdjustmentFactor: {
            type: "number",
            minimum: 0,
            maximum: 100
        },
        priorityAdjustmentFactor: {
            type: "number",
            minimum: 0,
            maximum: 100
        },
    },
    additionalProperties: false
}

const AMBS_SCHEMA = {
    $id: "ambs-schema",
    type: "array",
    items: {
        type: "object",
        properties: {
            name: { $ref: "non-empty-string-schema" },
            enabled: {
                type: "boolean"
            },
            incentivesAddress: { $ref: "address-field-schema" },
            packetCost: { $ref: "gas-field-schema" }
        },
        required: ["name"],
        additionalProperties: true,
    },
    minItems: 1
}

const CHAINS_SCHEMA = {
    $id: "chains-schema",
    type: "array",
    items: {
        type: "object",
        properties: {
            chainId: { $ref: "chain-id-schema" },
            name: { $ref: "non-empty-string-schema" },
            rpc: { $ref: "non-empty-string-schema" },
            resolver: { $ref: "non-empty-string-schema" },

            startingBlock: { $ref: "integer-schema" },
            stoppingBlock: { $ref: "positive-number-schema" },

            monitor: { $ref: "monitor-schema" },
            getter: { $ref: "getter-schema" },
            pricing: { $ref: "pricing-schema" },
            evaluator: { $ref: "evaluator-schema" },
            submitter: { $ref: "submitter-schema" },
            wallet: { $ref: "wallet-schema" },
        },
        required: ["chainId", "name", "rpc"],
        additionalProperties: true  // allow for 'amb' override config
    },
    minItems: 2
}

export function getConfigValidator(): AnyValidateFunction<unknown> {
    const ajv = new Ajv({ strict: true });
    ajv.addSchema(POSITIVE_NUMBER_SCHEMA);
    ajv.addSchema(INTEGER_SCHEMA);
    ajv.addSchema(POSITIVE_NON_ZERO_INTEGER_SCHEMA);
    ajv.addSchema(NON_EMPTY_STRING_SCHEMA);
    ajv.addSchema(ADDRESS_FIELD_SCHEMA);
    ajv.addSchema(GAS_FIELD_SCHEMA);
    ajv.addSchema(CHAIN_ID_SCHEMA);
    ajv.addSchema(PROCESSING_INTERVAL_SCHEMA);
    ajv.addSchema(CONFIG_SCHEMA);
    ajv.addSchema(GLOBAL_SCHEMA);
    ajv.addSchema(PRIVATE_KEY_SCHEMA);
    ajv.addSchema(MONITOR_SCHEMA);
    ajv.addSchema(GETTER_SCHEMA);
    ajv.addSchema(PRICING_SCHEMA);
    ajv.addSchema(EVALUATOR_SCHEMA);
    ajv.addSchema(SUBMITTER_SCHEMA);
    ajv.addSchema(PERSISTER_SCHEMA);
    ajv.addSchema(WALLET_SCHEMA);
    ajv.addSchema(AMBS_SCHEMA);
    ajv.addSchema(CHAINS_SCHEMA);

    const verifier = ajv.getSchema('config-schema');
    if (verifier == undefined) {
        throw new Error('Unable to load the \'config\' schema.');
    }

    return verifier;
}