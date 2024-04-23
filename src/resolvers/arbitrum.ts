import { JsonRpcProvider } from "ethers6";
import { Resolver, ResolverConfig } from "./resolver";
import pino from "pino";
import { tryErrorToString, wait } from "src/common/utils";

export const RESOLVER_TYPE_ARBITRUM = 'arbitrum';

export class ArbitrumResolver extends Resolver {
    override readonly resolverType;

    constructor(
        config: ResolverConfig,
        provider: JsonRpcProvider,
        logger: pino.Logger,
    ) {
        super(
            config,
            provider,
            logger,
        );

        this.resolverType = RESOLVER_TYPE_ARBITRUM;
    }

    //TODO implement block number caching?
    override async getTransactionBlockNumber(
        observedBlockNumber: number
    ): Promise<number> {

        for (let tryCount = 0; tryCount < this.config.maxRetries; tryCount++) {
            try {
                const blockData = await this.provider.send(
                    "eth_getBlockByNumber",
                    ["0x" + observedBlockNumber.toString(16), false]
                );

                if (blockData == undefined) {
                    throw new Error('Error on block query: response is undefined.');
                }

                const parsedL1BlockNumber = parseInt(blockData.l1BlockNumber, 16);
                if (isNaN(parsedL1BlockNumber)) {
                    throw new Error('Error on l1BlockNumber parsing: result is NaN.');
                }

                return parsedL1BlockNumber;
            }
            catch (error) {
                this.logger.warn(
                    {
                        resolver: this.resolverType,
                        observedBlockNumber,
                        error: tryErrorToString(error),
                        try: tryCount + 1,
                    },
                    `Error when mapping an 'observedBlockNumber' to an 'l1BlockNumber'. Will retry if possible.`
                );

                if (tryCount < this.config.maxRetries - 1) {
                    await wait(this.config.retryInterval);
                }
            }
        }

        throw new Error(`Failed to map an 'observedBlockNumber' to an 'l1BlockNumber'. Max tries reached.`);
    };

}

export default ArbitrumResolver;
