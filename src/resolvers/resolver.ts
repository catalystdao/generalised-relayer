import { JsonRpcProvider, TransactionRequest } from "ethers6";
import pino from "pino";

export const RESOLVER_TYPE_DEFAULT = 'default';

export const RESOLVER_CONFIG_DEFAULT: ResolverConfig = {
    maxRetries: 3,
    retryInterval: 2000,
}


export interface ResolverConfig {
    maxRetries: number;
    retryInterval: number;
}

export function loadResolver(
    resolver: string | null,
    provider: JsonRpcProvider,
    logger: pino.Logger,
    config?: ResolverConfig
): Resolver {

    let resolverClass: typeof Resolver;
    if (resolver == null) {
        resolverClass = Resolver;
    }
    else {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const module = require(`./${resolver}`);
        resolverClass = module.default;
    }


    return new resolverClass(
        config ?? RESOLVER_CONFIG_DEFAULT,
        provider,
        logger,
    );
}

export async function loadResolverAsync(
    resolver: string | null,
    provider: JsonRpcProvider,
    logger: pino.Logger,
    config?: ResolverConfig
): Promise<Resolver> {

    let resolverClass: typeof Resolver;
    if (resolver == null) {
        resolverClass = Resolver;
    }
    else {
        const module = await import(`./${resolver}`);
        resolverClass = module.default;
    }

    return new resolverClass(
        config ?? RESOLVER_CONFIG_DEFAULT,
        provider,
        logger,
    );
}

export interface GasEstimateComponents {
    gasEstimate: bigint;                // The overall gas usage (used to set the transaction 'gasLimit').
    observedGasEstimate: bigint;        // The gas usage observed by the contract.
    additionalFeeEstimate: bigint;      // Any additional fee incurred by the transaction.
}

export class Resolver {
    readonly resolverType;

    constructor(
        protected readonly config: ResolverConfig,
        protected readonly provider: JsonRpcProvider,
        protected readonly logger: pino.Logger
    ) {
        this.resolverType = RESOLVER_TYPE_DEFAULT;
    }

    getTransactionBlockNumber(
        observedBlockNumber: number
    ): Promise<number> {
        return new Promise((resolve) => resolve(observedBlockNumber));
    };

    async estimateGas(
        transactionRequest: TransactionRequest
    ): Promise<GasEstimateComponents> {
        const gasEstimatePromise = this.provider.estimateGas(transactionRequest);
        const additionalFeeEstimatePromise = this.estimateAdditionalFee(transactionRequest);

        const [
            gasEstimate,
            additionalFeeEstimate
        ] = await Promise.all([gasEstimatePromise, additionalFeeEstimatePromise]);

        return {
            gasEstimate,
            observedGasEstimate: gasEstimate,
            additionalFeeEstimate,
        };
    }

    estimateAdditionalFee(
        _transactionRequest: TransactionRequest
    ): Promise<bigint> {
        return new Promise((resolve) => resolve(0n));
    }
}
