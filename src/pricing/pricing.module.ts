import { Global, Module } from '@nestjs/common';
import { PricingService } from './pricing.service';
import { PricingController } from './pricing.controller';

@Global()
@Module({
    controllers: [PricingController],
    providers: [PricingService],
    exports: [PricingService],
})
export class PricingModule {}
