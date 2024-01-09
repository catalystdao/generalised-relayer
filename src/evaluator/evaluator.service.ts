import { Injectable } from '@nestjs/common';
import { Bounty } from 'src/store/types/store.types';
import { LoggerService } from 'src/logger/logger.service';

@Injectable()
export class EvaluatorService {
  constructor(private readonly logger: LoggerService) {}

  /**
   * Evaluates bounties to gauge their profitability
   * @param bounty
   * @param chain
   * @param address
   * @returns The bounty mutation with the evaluation parameters
   */
  async evaluateBounty(bounty: Bounty, address: string): Promise<Bounty> {
    this.logger.info(`Checking gas price for bounty ${bounty.messageIdentifier}`);

    //TODO implement evaluating currently it's just being forwarded

    return bounty;
  }
}
