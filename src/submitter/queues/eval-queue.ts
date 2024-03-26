import {
  HandleOrderResult,
  ProcessingQueue,
} from '../../processing-queue/processing-queue';
import { EvalOrder, SubmitOrder } from '../submitter.types';
import pino from 'pino';
import { Store } from 'src/store/store.lib';
import { Bounty } from 'src/store/types/store.types';
import { BountyStatus } from 'src/store/types/bounty.enum';
import { IncentivizedMessageEscrow } from 'src/contracts';
import { tryErrorToString } from 'src/common/utils';
import { zeroPadValue } from 'ethers6';

export class EvalQueue extends ProcessingQueue<EvalOrder, SubmitOrder> {
  readonly relayerAddress: string;

  constructor(
    readonly retryInterval: number,
    readonly maxTries: number,
    private readonly store: Store,
    private readonly incentivesContracts: Map<
      string,
      IncentivizedMessageEscrow
    >,
    private readonly chainId: string,
    private readonly gasLimitBuffer: Record<string, number>,
    relayerAddress: string,
    private readonly logger: pino.Logger,
  ) {
    super(retryInterval, maxTries);
    this.relayerAddress = zeroPadValue(relayerAddress, 32);
  }

  protected async handleOrder(
    order: EvalOrder,
    _retryCount: number,
  ): Promise<HandleOrderResult<SubmitOrder> | null> {
    const gasLimit = await this.evaluateBounty(order);

    if (gasLimit > 0) {
      // Move the order to the submit queue
      return { result: { ...order, gasLimit } };
    } else {
      return null;
    }
  }

  protected async handleFailedOrder(
    order: EvalOrder,
    retryCount: number,
    error: any,
  ): Promise<boolean> {
    const errorDescription = {
      messageIdentifier: order.messageIdentifier,
      error: tryErrorToString(error),
      try: retryCount + 1,
    };

    if (error.code === 'CALL_EXCEPTION') {
      //TODO improve error filtering?
      this.logger.info(
        errorDescription,
        `Failed to evaluate message: CALL_EXCEPTION. It has likely been relayed by another relayer. Dropping message.`,
      );
      return false; // Do not retry eval
    }

    this.logger.warn(errorDescription, `Error on order eval.`);

    return true;
  }

  protected async onOrderCompletion(
    order: EvalOrder,
    success: boolean,
    result: SubmitOrder | null,
    retryCount: number,
  ): Promise<void> {
    const orderDescription = {
      messageIdentifier: order.messageIdentifier,
      try: retryCount + 1,
    };

    if (success) {
      if (result?.gasLimit != null && result.gasLimit > 0) {
        this.logger.debug(
          orderDescription,
          `Successful bounty evaluation: submit order.`,
        );
      } else {
        this.logger.debug(
          orderDescription,
          `Successful bounty evaluation: drop order.`,
        );
      }
    } else {
      this.logger.error(orderDescription, `Unsuccessful bounty evaluation.`);
    }
  }

  /**
   * TODO: What is the point of this helper?
   */
  private async queryBountyInfo(
    messageIdentifier: string,
  ): Promise<Bounty | null> {
    return this.store.getBounty(messageIdentifier);
  }

  private async evaluateBounty(order: EvalOrder): Promise<bigint> {
    const messageIdentifier = order.messageIdentifier;
    const bounty = await this.queryBountyInfo(messageIdentifier);
    if (bounty === null || bounty === undefined) {
      throw Error(
        `Bounty of message not found on evaluation (message ${messageIdentifier})`,
      );
    }

    // Check if the bounty has already been submitted/is in process of being submitted
    const isDelivery = bounty.fromChainId != this.chainId;
    if (isDelivery) {
      // Source to Destination
      if (bounty.status >= BountyStatus.MessageDelivered) {
        this.logger.debug(
          { messageIdentifier },
          `Bounty evaluation (source to destination). Bounty already delivered.`,
        );
        return 0n; // Do not relay packet
      }
    } else {
      // Destination to Source
      if (bounty.status >= BountyStatus.BountyClaimed) {
        this.logger.debug(
          { messageIdentifier },
          `Bounty evaluation (destination to source). Bounty already acked.`,
        );
        return 0n; // Do not relay packet
      }
    }

    const contract = this.incentivesContracts.get(order.amb)!; //TODO handle undefined case
    const gasEstimation = await contract.processPacket.estimateGas(
      order.messageCtx,
      order.message,
      this.relayerAddress,
    );

    const gasLimitBuffer = this.getGasLimitBuffer(order.amb);

    //TODO gas prices are not being considered at this point
    if (isDelivery) {
      // Source to Destination
      const gasLimit = BigInt(bounty.maxGasDelivery + gasLimitBuffer);

      this.logger.debug(
        {
          messageIdentifier,
          gasLimit,
          maxGasDelivery: bounty.maxGasDelivery,
          gasLimitBuffer,
          gasEstimation: gasEstimation.toString(),
        },
        `Bounty evaluation (source to destination).`,
      );

      const isGasLimitEnough = gasLimit >= gasEstimation;
      const relayDelivery = order.priority || isGasLimitEnough;
      return relayDelivery
        ? (isGasLimitEnough ? gasLimit : gasEstimation) // Return the largest of gasLimit and gasEstimation
        : 0n;
    } else {
      // Destination to Source
      const gasLimit = BigInt(bounty.maxGasAck + gasLimitBuffer);

      this.logger.debug(
        {
          messageIdentifier,
          gasLimit,
          maxGasAck: bounty.maxGasAck,
          gasLimitBuffer,
          gasEstimation: gasEstimation.toString(),
        },
        `Bounty evaluation (destination to source).`,
      );

      const isGasLimitEnough = gasLimit >= gasEstimation;
      const relayAck = order.priority || isGasLimitEnough;
      return relayAck
        ? (isGasLimitEnough ? gasLimit : gasEstimation) // Return the largest of gasLimit and gasEstimation
        : 0n;
    }

    return 0n; // Do not relay packet
  }

  private getGasLimitBuffer(amb: string): number {
    return this.gasLimitBuffer[amb] ?? this.gasLimitBuffer['default'] ?? 0;
  }
}
