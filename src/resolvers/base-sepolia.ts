import pino from "pino";
import { JsonRpcProvider } from "ethers6";
import { ResolverConfig } from "./resolver";
import OPStackResolver from "./op-stack";

export const BASE_SEPOLIA_CHAIN_NAME = 'baseSepolia';

export class BaseSepoliaResolver extends OPStackResolver {

    constructor(
        config: ResolverConfig,
        provider: JsonRpcProvider,
        logger: pino.Logger,
    ) {
        super(
            BASE_SEPOLIA_CHAIN_NAME,
            config,
            provider,
            logger,
        );
    }
}

export default BaseSepoliaResolver;
