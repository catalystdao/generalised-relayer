import { Module } from '@nestjs/common';
import { PersisterService } from './persister.service';

@Module({
  providers: [PersisterService],
  exports: [PersisterService],
})
export class PersisterModule {}
