import { Controller, Get, OnModuleInit, Query } from "@nestjs/common";
import { PricingService } from './pricing.service';
import { PricingInterface } from './pricing.interface';
import { GetPriceQuery, GetPriceQueryResponse } from './pricing.types';


@Controller()
export class PricingController implements OnModuleInit {
    private pricing!: PricingInterface;

    constructor(
        private readonly pricingService: PricingService,
    ) {}

    async onModuleInit() {
        await this.initializePricingInterface();
    }

    private async initializePricingInterface(): Promise<void> {
        const port = await this.pricingService.attachToPricing();
        this.pricing = new PricingInterface(port);
    }

    @Get('getPrice')
    async getPrice(@Query() query: GetPriceQuery): Promise<any> {
        //TODO schema validate request

        if (query.chainId == undefined || query.amount == undefined) {
            return undefined;   //TODO return error
        }

        const amount = BigInt(query.amount);
        const price = await this.pricing.getPrice(
            query.chainId,
            amount,
            query.tokenId,
        );

        const response: GetPriceQueryResponse = {
            chainId: query.chainId,
            tokenId: query.tokenId,
            amount: amount.toString(),
            price: price != null ? price : null,
        };

        return response;
    }
}