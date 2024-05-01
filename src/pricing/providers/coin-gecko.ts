import pino from "pino";
import fetch from "node-fetch";
import { PricingProviderConfig, PricingProvider } from "../pricing.provider";

export const PRICING_TYPE_COIN_GECKO = 'coin-gecko';
export const BASE_COIN_GECKO_URL = 'https://api.coingecko.com/api/v3';

//TODO add support for an api key

export interface CoinGeckoPricingConfig extends PricingProviderConfig {
    coinId: string;
}

export class FixedPricingProvider extends PricingProvider<CoinGeckoPricingConfig> {
    readonly pricingProviderType = PRICING_TYPE_COIN_GECKO;

    constructor(
        config: CoinGeckoPricingConfig,
        logger: pino.Logger,
    ) {
        super(config, logger);
    }

    async queryCoinPrice(): Promise<number> {

        const coinId = this.config.coinId;
        const denom = this.config.pricingDenomination.toLowerCase();
        const endpoint = `${BASE_COIN_GECKO_URL}/simple/price?ids=${coinId}&vs_currencies=${denom}`;

        const response = await fetch(endpoint, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' },
        });

        const parsedResponse: any = await response.json();
        const price = Number(parsedResponse[coinId]?.[denom]);

        if (isNaN(price)) {
            throw new Error(
                `Failed to parse api query response (endpoint ${endpoint}, response ${JSON.stringify(parsedResponse)})`
            );
        }

        return price;
    }
}
