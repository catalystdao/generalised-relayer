import pino from "pino";
import { JsonRpcProvider } from "ethers6";
import { ResolverConfig } from "./resolver";
import OPStackResolver from "./op-stack";

export const OPTIMISM_CHAIN_NAME = 'optimism';

export class OptimismResolver extends OPStackResolver {

    constructor(
        config: ResolverConfig,
        provider: JsonRpcProvider,
        logger: pino.Logger,
    ) {
        super(
            OPTIMISM_CHAIN_NAME,
            config,
            provider,
            logger,
        );
    }
}

export default OptimismResolver;
