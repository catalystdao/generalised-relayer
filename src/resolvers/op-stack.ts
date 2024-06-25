import { JsonRpcProvider, TransactionRequest } from "ethers6";
import { Resolver, ResolverConfig } from "./resolver";
import pino from "pino";
import { createPublicClient, http } from "viem";
import { publicActionsL2 } from 'viem/op-stack'

export const RESOLVER_TYPE_OP_STACK = 'op-stack';

export class OPStackResolver extends Resolver {
    override readonly resolverType;

    private client: any;    //TODO use VIEM types

    constructor(
        chainName: string,
        config: ResolverConfig,
        provider: JsonRpcProvider,
        logger: pino.Logger,
    ) {
        super(
            config,
            provider,
            logger,
        );

        this.resolverType = RESOLVER_TYPE_OP_STACK;

        this.client = this.loadClient(
            chainName,
            this.provider._getConnection().url  //TODO the 'rpc' url should be added to the ResolverConfig
        );
    }

    private loadClient(
        chainName: string,
        rpc: string,
    ): any {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const chain = require(`viem/chains`)[chainName];

        return createPublicClient({
            chain,
            transport: http(rpc),
        }).extend(publicActionsL2());
    }

    override async estimateAdditionalFee(
        transactionRequest: TransactionRequest
    ): Promise<bigint> {
        return this.client.estimateL1Fee(transactionRequest)
    }
}

export default OPStackResolver;
