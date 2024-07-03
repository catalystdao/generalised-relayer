import { Global, Module } from '@nestjs/common';
import { PricingModule } from './../pricing/pricing.module';
import { WalletModule } from 'src/wallet/wallet.module';
import { EvaluatorService } from './evaluator.service';

@Global()
@Module({
    providers: [EvaluatorService],
    exports: [EvaluatorService],
    imports: [PricingModule, WalletModule],
})
export class EvaluatorModule {}
