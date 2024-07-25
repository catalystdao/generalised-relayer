import pino from "pino";
import { PricingProviderConfig, PricingProvider } from "../pricing.provider";

export const PRICING_TYPE_FIXED = 'fixed';

export interface FixedPricingConfig extends PricingProviderConfig {
    value: number;
}

export class FixedPricingProvider extends PricingProvider<FixedPricingConfig> {
    readonly pricingProviderType = PRICING_TYPE_FIXED;

    constructor(
        config: FixedPricingConfig,
        logger: pino.Logger,
    ) {
        super(config, logger);
    }

    async queryCoinPrice(): Promise<number> {
        return this.config.value;
    }
}

export default FixedPricingProvider;
