import { Module } from '@nestjs/common';
import { LoggerModule } from 'src/logger/logger.module';
import { GetterController } from './getter.controller';

@Module({
  controllers: [GetterController],
  imports: [LoggerModule],
})
export class GetterModule {}
