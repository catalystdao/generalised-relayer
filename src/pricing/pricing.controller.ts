import { Controller, Get, Param, Query } from '@nestjs/common';
import { PricingService } from './pricing.service';

@Controller('pricing')
export class PricingController {
  constructor(
    private readonly pricingService: PricingService
  ) {}

  @Get(':chainId/price')
  async getPrice(
    @Param('chainId') chainId: string,
    @Query('amount') amount: string,
  ): Promise<number> {
    const amountBigInt = BigInt(amount);
    return this.pricingService.getAssetPrice(chainId, amountBigInt);
  }
  
}
