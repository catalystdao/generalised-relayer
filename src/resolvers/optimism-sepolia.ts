import pino from "pino";
import { JsonRpcProvider } from "ethers6";
import { ResolverConfig } from "./resolver";
import OPStackResolver from "./op-stack";

export const OPTIMISM_SEPOLIA_CHAIN_NAME = 'optimismSepolia';

export class OptimismSepoliaResolver extends OPStackResolver {

    constructor(
        config: ResolverConfig,
        provider: JsonRpcProvider,
        logger: pino.Logger,
    ) {
        super(
            OPTIMISM_SEPOLIA_CHAIN_NAME,
            config,
            provider,
            logger,
        );
    }
}

export default OptimismSepoliaResolver;
