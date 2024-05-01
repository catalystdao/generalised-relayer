import pino from "pino";
import axios from "axios";
import { PricingProviderConfig, PricingProvider } from "../pricing.provider";

export const PRICING_TYPE_COIN_GECKO = 'coin-gecko';
export const BASE_COIN_GECKO_URL = 'https://api.coingecko.com/api/v3';

//TODO add support for an api key

export interface CoinGeckoPricingConfig extends PricingProviderConfig {
    coinId: string;
}

export class FixedPricingProvider extends PricingProvider<CoinGeckoPricingConfig> {
    readonly pricingProviderType = PRICING_TYPE_COIN_GECKO;

    private readonly client = axios.create({
        baseURL: BASE_COIN_GECKO_URL,
    })

    constructor(
        config: CoinGeckoPricingConfig,
        logger: pino.Logger,
    ) {
        super(config, logger);
    }

    async queryCoinPrice(): Promise<number> {

        const coinId = this.config.coinId;
        const denom = this.config.pricingDenomination.toLowerCase();
        const path = `/simple/price?ids=${coinId}&vs_currencies=${denom}`;

        const { data } = await this.client.get(path);

        const price = Number(data[coinId]?.[denom]);

        if (isNaN(price)) {
            throw new Error(
                `Failed to parse api query response (url ${BASE_COIN_GECKO_URL}, path ${path}, response ${JSON.stringify(data)})`
            );
        }

        return price;
    }
}
