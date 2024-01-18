import { HandleOrderResult, ProcessingQueue } from './processing-queue';
import { SubmitOrder, SubmitOrderResult } from '../submitter.types';
import { Wallet } from 'ethers';
import pino from 'pino';
import { IncentivizedMessageEscrow } from 'src/contracts';
import { hexZeroPad } from 'ethers/lib/utils';
import { TransactionHelper } from '../transaction-helpers';

export class SubmitQueue extends ProcessingQueue<
  SubmitOrder,
  SubmitOrderResult
> {
  private relayerAddress: string;

  constructor(
    readonly retryInterval: number,
    readonly maxTries: number,
    private readonly incentivesContracts: Map<
      string,
      IncentivizedMessageEscrow
    >,
    private readonly transactionHelper: TransactionHelper,
    private readonly transactionTimeout: number,
    private readonly signer: Wallet,
    private readonly logger: pino.Logger,
  ) {
    super(retryInterval, maxTries);
  }

  async init(): Promise<void> {
    this.relayerAddress = hexZeroPad(await this.signer.getAddress(), 32);
  }

  protected async onProcessOrders(): Promise<void> {
    await this.transactionHelper.updateFeeData();
  }

  protected async handleOrder(
    order: SubmitOrder,
    retryCount: number,
  ): Promise<HandleOrderResult<SubmitOrderResult> | null> {
    // Simulate the packet submission as a static call. Skip if it's the first submission try,
    // as in that case the packet 'evaluation' will have been executed shortly before.
    const contract = this.incentivesContracts.get(order.amb)!; //TODO handle undefined case

    if (retryCount > 0) {
      await contract.callStatic.processPacket(
        order.messageCtx,
        order.message,
        this.relayerAddress,
        {
          gasLimit: order.gasLimit,
        },
      );
    }

    // Execute the relay transaction if the static call did not fail.
    const tx = await contract.processPacket(
      order.messageCtx,
      order.message,
      this.relayerAddress,
      {
        nonce: this.transactionHelper.getTransactionCount(),
        ...this.transactionHelper.getFeeDataForTransaction(),
      },
    );

    this.transactionHelper.increaseTransactionCount();

    this.logger.info(
      { messageIdentifier: order.messageIdentifier, txHash: tx.hash },
      `Submitted message.`,
    );

    const timingOutTxPromise: Promise<SubmitOrderResult> = Promise.race([
      tx.wait().then((receipt: any) => {
        if (receipt == null) {
          throw new Error('Submit tx TIMEOUT');
        }
        return { txHash: receipt.hash, ...order };
      }),

      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject('Submit tx TIMEOUT'), this.transactionTimeout),
      ),
    ]);

    return { result: timingOutTxPromise };
  }

  protected async handleFailedOrder(
    order: SubmitOrder,
    retryCount: number,
    error: any,
  ): Promise<boolean> {
    const errorDescription = {
      messageIdentifier: order.messageIdentifier,
      error,
      try: retryCount + 1,
    };

    if (error.code === 'CALL_EXCEPTION') {
      //TODO improve error filtering?
      this.logger.info(
        errorDescription,
        `Error on message submission: CALL_EXCEPTION. It has likely been relayed by another relayer. Dropping message.`,
      );
      return false; // Do not retry eval
    }

    this.logger.warn(errorDescription, `Error on message submission`);

    if (
      error.code === 'NONCE_EXPIRED' ||
      error.code === 'REPLACEMENT_UNDERPRICED' ||
      error.error?.message.includes('invalid sequence')
    ) {
      await this.transactionHelper.updateTransactionCount();
    }

    return true;
  }

  protected async onOrderCompletion(
    order: SubmitOrder,
    success: boolean,
    result: SubmitOrderResult | null,
    retryCount: number,
  ): Promise<void> {
    const orderDescription = {
      messageIdentifier: order.messageIdentifier,
      txHash: result?.txHash,
      try: retryCount + 1,
    };

    if (success) {
      if (result?.gasLimit != 0) {
        this.logger.debug(
          orderDescription,
          `Successful message processing: message submitted.`,
        );
      } else {
        this.logger.debug(
          orderDescription,
          `Successful message processing: message not submitted.`,
        );
      }
    } else {
      this.logger.error(orderDescription, `Unsuccessful message processing.`);
    }
  }
}
