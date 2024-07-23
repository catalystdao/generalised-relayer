import pino from "pino";
import { JsonRpcProvider } from "ethers6";
import { ResolverConfig } from "./resolver";
import OPStackResolver from "./op-stack";

export const BASE_CHAIN_NAME = 'base';

export class BaseResolver extends OPStackResolver {

    constructor(
        config: ResolverConfig,
        provider: JsonRpcProvider,
        logger: pino.Logger,
    ) {
        super(
            BASE_CHAIN_NAME,
            config,
            provider,
            logger,
        );
    }
}

export default BaseResolver;
