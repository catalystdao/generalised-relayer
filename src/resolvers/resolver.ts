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

    estimateAdditionalFee(
        _transactionRequest: TransactionRequest
    ): Promise<bigint> {
        return new Promise((resolve) => resolve(0n));
    }
}
