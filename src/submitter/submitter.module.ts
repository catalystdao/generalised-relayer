import { Module } from '@nestjs/common';
import { LoggerModule } from 'src/logger/logger.module';
import { SubmitterService } from './submitter.service';
import { WalletModule } from 'src/wallet/wallet.module';

@Module({
  providers: [SubmitterService],
  exports: [SubmitterService],
  imports: [LoggerModule, WalletModule],
})
export class SubmitterModule {}
