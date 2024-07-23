import { Global, Module } from '@nestjs/common';
import { PricingModule } from './../pricing/pricing.module';
import { WalletModule } from 'src/wallet/wallet.module';
import { EvaluatorService } from './evaluator.service';
import { EvaluatorController } from './evaluator.controller';

@Global()
@Module({
    controllers: [EvaluatorController],
    providers: [EvaluatorService],
    exports: [EvaluatorService],
    imports: [PricingModule, WalletModule],
})
export class EvaluatorModule {}
