import { Module } from '@nestjs/common';
import { LoggerModule } from 'src/logger/logger.module';
import { PersisterService } from './persister.service';

@Module({
  providers: [PersisterService],
  exports: [PersisterService],
  imports: [LoggerModule],
})
export class PersisterModule {}
