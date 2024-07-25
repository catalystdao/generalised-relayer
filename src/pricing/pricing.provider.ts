import pino from "pino";
import { tryErrorToString, wait } from "src/common/utils";

export const MAX_CACHE_DURATION = 1 * 60 * 60 * 1000;   // 1 hour

export interface PricingProviderConfig {
    provider: string;
    coinDecimals: number;
    pricingDenomination: string;
    cacheDuration: number;
    retryInterval: number;
    maxTries: number;
    [key: string]: any; // Allow for additional provider-specific options
}

export function loadPricingProvider<Config extends PricingProviderConfig>(
    config: Config,
    logger: pino.Logger
): PricingProvider<Config> {

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const module = require(`./providers/${config.provider}`);
    const providerClass: typeof BasePricingProvider = module.default;
    return new providerClass(
        config,
        logger,
    ) as unknown as PricingProvider<Config>;
}

export async function loadPricingProviderAsync<Config extends PricingProviderConfig>(
    config: Config,
    logger: pino.Logger
): Promise<PricingProvider<Config>> {

    const module = await import(`./providers/${config.provider}`);
    const providerClass: typeof BasePricingProvider = module.default;
    return new providerClass(
        config,
        logger,
    ) as unknown as PricingProvider<Config>;
}

interface CachedPriceData {
    price: number;
    timestamp: number;
}


export abstract class PricingProvider<Config extends PricingProviderConfig> {
    readonly abstract pricingProviderType: string;

    protected cachedGasPrice: CachedPriceData | undefined;
    protected cachedTokenPrices: Record<string, CachedPriceData> = {};

    constructor(
        protected readonly config: Config,
        protected readonly logger: pino.Logger,
    ) {
        this.validateConfig(this.config);
    }



    // Initialization helpers
    // ********************************************************************************************

    private validateConfig(config: Config): void {
        if (config.cacheDuration > MAX_CACHE_DURATION) {
            throw new Error(
                `Invalid 'cacheDuration': exceeds maximum allowed (${config.cacheDuration} exceeds ${MAX_CACHE_DURATION}).`
            );
        }
    }



    // Pricing functions
    // ********************************************************************************************

    abstract queryCoinPrice(tokenId?: string): Promise<number>;

    async getPrice(amount: bigint, tokenId?: string): Promise<number> {
        const cachedPriceData = tokenId == undefined
            ? this.cachedGasPrice
            : this.cachedTokenPrices[tokenId];

        const cacheValidUntilTimestamp = cachedPriceData != undefined
            ? cachedPriceData.timestamp + this.config.cacheDuration
            : null;

        const isCacheValid = cacheValidUntilTimestamp != null && Date.now() < cacheValidUntilTimestamp;

        const latestPriceData = isCacheValid
            ? cachedPriceData!
            : await this.updateCoinPrice(tokenId);

        return latestPriceData.price * Number(amount) / 10**this.config.coinDecimals;
    }

    private async updateCoinPrice(tokenId?: string): Promise<CachedPriceData> {

        const cachedPriceData = tokenId == undefined
            ? this.cachedGasPrice
            : this.cachedTokenPrices[tokenId];

        let latestPrice: number | undefined;

        let tryCount = 0;
        while (latestPrice == undefined) {
            try {
                latestPrice = await this.queryCoinPrice(tokenId);
            }
            catch (error) {
                this.logger.warn(
                    {
                        error: tryErrorToString(error),
                        try: ++tryCount,
                    },
                    `Failed to query coin price. Retrying if possible.`
                );
                
                // Skip update and continue with 'stale' pricing info if 'maxTries' is reached, unless
                // the price has never been successfully queried from the provider.
                if (tryCount >= this.config.maxTries && cachedPriceData != undefined) {
                    this.logger.warn(
                        {
                            try: tryCount,
                            maxTries: this.config.maxTries,
                            price: cachedPriceData.price,
                            pricingDenomination: this.config.pricingDenomination,
                            lastUpdate: cachedPriceData.timestamp,
                            tokenId,
                        },
                        `Failed to query token price. Max tries reached. Continuing with stale data.`
                    );
                    return cachedPriceData;
                }

                await wait(this.config.retryInterval);
            }
        }

        const latestPriceData: CachedPriceData = {
            price: latestPrice,
            timestamp: Date.now(),
        };

        if (tokenId == undefined) {
            this.cachedGasPrice = latestPriceData;
        }
        else {
            this.cachedTokenPrices[tokenId] = latestPriceData;
        }

        this.logger.info(
            {
                price: latestPrice,
                pricingDenomination: this.config.pricingDenomination,
                tokenId,
            },
            'Token price updated.'
        )
        return latestPriceData;
    }

}

// ! The following class should not be used, rather it is only provided for typing purposes.
export class BasePricingProvider extends PricingProvider<PricingProviderConfig> {
    readonly pricingProviderType: string = 'basePricingProvider';

    async queryCoinPrice(): Promise<number> {
        throw new Error("Method not implemented.");
    }

}
