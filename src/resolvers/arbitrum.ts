import { Interface, JsonRpcProvider, TransactionRequest } from "ethers6";
import { GasEstimateComponents, Resolver, ResolverConfig } from "./resolver";
import pino from "pino";
import { tryErrorToString, wait } from "src/common/utils";

export const RESOLVER_TYPE_ARBITRUM = 'arbitrum';

// Arbitrum NodeInterface docs:
// https://docs.arbitrum.io/build-decentralized-apps/nodeinterface/reference
const ARBITRUM_NODE_INTERFACE_ADDRESS = '0x00000000000000000000000000000000000000c8';
const GAS_ESTIMATE_COMPONENTS_SIGNATURE = 'function gasEstimateComponents(address to, bool contractCreation, bytes calldata data) returns (uint64, uint64, uint256, uint256)';

export class ArbitrumResolver extends Resolver {
    override readonly resolverType;

    private arbitrumNodeInterface = new Interface([
        GAS_ESTIMATE_COMPONENTS_SIGNATURE
    ]);

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

    override async estimateGas(
        transactionRequest: TransactionRequest
    ): Promise<GasEstimateComponents> {

        // This function relies on Arbitrum's 'gasEstimateComponents' to estimate the gas components.
        // https://github.com/OffchainLabs/nitro-contracts/blob/1cab72ff3dfcfe06ceed371a9db7a54a527e3bfb/src/node-interface/NodeInterface.sol#L84
        
        // Set the requested transaction's 'to' and 'data' fields within the
        // 'gasEstimateComponents' function arguments, as these fields will be replaced when
        // calling the `gasEstimateComponents` function.
        const transactionData = this.arbitrumNodeInterface.encodeFunctionData(
            "gasEstimateComponents",
            [
                transactionRequest.to,
                false,  // 'contractCreation'
                transactionRequest.data ?? "0x"
            ]
        );

        const result = await this.provider.call({
            ...transactionRequest,
            to: ARBITRUM_NODE_INTERFACE_ADDRESS,    // Replace the 'to' address with Arbitrum's NodeInterface address.
            data: transactionData                   // Replace the tx data with the encoded function arguments above.
        });

        const decodedResult = this.arbitrumNodeInterface.decodeFunctionResult(
            "gasEstimateComponents",
            result
        );

        const gasEstimate: bigint = decodedResult[0];
        const l1GasEstimate: bigint = decodedResult[1];

        if (l1GasEstimate > gasEstimate) {
            throw new Error(`Error on 'gasEstimateComponents' call (Arbitrum): returned 'l1GasEstimate' is larger than 'gasEstimate'.`);
        }

        return {
            gasEstimate,
            observedGasEstimate: gasEstimate - l1GasEstimate,
            additionalFeeEstimate: 0n,
        }

    }
}

export default ArbitrumResolver;
