import { Module } from '@nestjs/common';
import { SubmitterService } from './submitter.service';
import { WalletModule } from 'src/wallet/wallet.module';

@Module({
  providers: [SubmitterService],
  exports: [SubmitterService],
  imports: [WalletModule],
})
export class SubmitterModule {}
