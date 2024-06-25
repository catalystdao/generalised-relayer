import { Global, Module } from '@nestjs/common';
import { PricingService } from './pricing.service';

@Global()
@Module({
    providers: [PricingService],
    exports: [PricingService],
})
export class PricingModule {}
