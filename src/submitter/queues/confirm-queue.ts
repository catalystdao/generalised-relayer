import { HandleOrderResult, ProcessingQueue } from './processing-queue';
import { SubmitOrderResult } from '../submitter.types';
import { BigNumber, Wallet } from 'ethers';
import pino from 'pino';
import { IncentivizedMessageEscrow } from 'src/contracts';
import { hexZeroPad } from 'ethers/lib/utils';
import { TransactionHelper } from '../transaction-helper';
import { BaseProvider, TransactionReceipt } from '@ethersproject/providers';

export class ConfirmQueue extends ProcessingQueue<
  SubmitOrderResult,
  TransactionReceipt
> {
  readonly relayerAddress: string;

  constructor(
    readonly retryInterval: number,
    readonly maxTries: number,
    private readonly confirmations: number,
    private readonly incentivesContracts: Map<
      string,
      IncentivizedMessageEscrow
    >,
    private readonly transactionHelper: TransactionHelper,
    private readonly confirmationTimeout: number,
    private readonly provider: BaseProvider,
    private readonly wallet: Wallet,
    private readonly logger: pino.Logger,
  ) {
    super(
      retryInterval,
      maxTries,
      1, // Confirm transactions one at a time
    );
    this.relayerAddress = hexZeroPad(this.wallet.address, 32);
  }

  protected async onOrderInit(order: SubmitOrderResult): Promise<void> {
    order.resubmit = false;
  }

  protected async handleOrder(
    order: SubmitOrderResult,
    retryCount: number,
  ): Promise<HandleOrderResult<TransactionReceipt> | null> {
    // If it's the first time the order is processed, just wait for it
    if (retryCount == 0) {
      const transactionReceipt = this.provider.waitForTransaction(
        order.tx.hash,
        this.confirmations,
        this.confirmationTimeout,
      );

      return { result: transactionReceipt };
    }

    // Reprice the order if it hasn't been repriced
    if (!order.replaceTx) {
      // Reprice the order
      const originalTx = order.tx;
      const contract = this.incentivesContracts.get(order.amb)!;

      const increasedFeeConfig =
        this.transactionHelper.getIncreasedFeeDataForTransaction(originalTx);

      const tx = await contract.processPacket(
        order.messageCtx,
        order.message,
        this.relayerAddress,
        {
          gasLimit: originalTx.gasLimit,
          nonce: originalTx.nonce,
          ...increasedFeeConfig,
        },
      );
      order.replaceTx = tx;

      await this.transactionHelper.registerBalanceUse(
        tx.gasLimit
          .mul(tx.maxFeePerGas ?? tx.gasPrice ?? BigNumber.from(0))
          .sub(
            originalTx.gasLimit.mul(
              originalTx.maxFeePerGas ??
                originalTx.gasPrice ??
                BigNumber.from(0),
            ),
          ),
      );
    }

    // Wait for either the original or the replace transaction to fulfill
    const originalTxReceipt = this.provider.waitForTransaction(
      order.tx.hash,
      this.confirmations,
      this.confirmationTimeout,
    );
    const replaceTxReceipt = this.provider.waitForTransaction(
      order.replaceTx!.hash,
      this.confirmations,
      this.confirmationTimeout,
    );

    const confirmationPromise = Promise.any([
      originalTxReceipt,
      replaceTxReceipt,
    ]).catch((aggregateError) => {
      // If both the original/replace tx promises reject, throw the error of the replace tx.
      throw aggregateError.errors?.[1];
    });

    return { result: confirmationPromise };
  }

  protected async handleFailedOrder(
    order: SubmitOrderResult,
    retryCount: number,
    error: any,
  ): Promise<boolean> {
    // ! This logic only runs if the tx has **not** been repriced.
    if (retryCount == 0) {
      return this.handleFailedOriginalOrder(order, retryCount, error);
    } else {
      return this.handleFailedRepricedOrder(order, retryCount, error);
    }
  }

  private async handleFailedOriginalOrder(
    order: SubmitOrderResult,
    retryCount: number,
    error: any,
  ): Promise<boolean> {
    const errorDescription = {
      messageIdentifier: order.messageIdentifier,
      error,
      requeueCount: order.requeueCount,
      try: retryCount + 1,
    };

    // If tx timeouts, retry the order. This will cause `handleOrder` to reprice the tx.
    if (error.code === 'TIMEOUT') {
      this.logger.info(
        errorDescription,
        `Error on transaction confirmation: TIMEOUT. Transaction will be sped up.`,
      );
      return true;
    }

    // If tx errors with 'CALL_EXCEPTION', drop the order
    if (error.code === 'CALL_EXCEPTION') {
      this.logger.info(
        errorDescription,
        `Error on transaction confirmation: CALL_EXCEPTION. It has likely been relayed by another relayer. Dropping message.`,
      );
      return false; // Do not retry order confirmation
    }

    // If tx errors because of an invalid nonce, requeue the order for submission
    if (
      error.code === 'NONCE_EXPIRED' ||
      error.code === 'REPLACEMENT_UNDERPRICED' ||
      error.error?.message.includes('invalid sequence') //TODO is this dangerous? (any contract may include that error)
    ) {
      this.logger.info(
        errorDescription,
        `Error on transaction confirmation: nonce error. Requeue order for submission if possible.`,
      );
      order.resubmit = true;
      return false; // Do not retry order confirmation
    }

    // Unknown error on confirmation. Requeue the order for submission
    this.logger.warn(
      errorDescription,
      `Error on transaction confirmation. Requeue order for submission if possible.`,
    );
    order.resubmit = true;
    return false; // Do not retry order confirmation
  }

  private async handleFailedRepricedOrder(
    order: SubmitOrderResult,
    retryCount: number,
    error: any,
  ): Promise<boolean> {
    const errorDescription = {
      messageIdentifier: order.messageIdentifier,
      error,
      requeueCount: order.requeueCount,
      try: retryCount + 1,
    };

    // If tx timeouts, keep waiting.
    if (error.code === 'TIMEOUT') {
      this.logger.info(
        errorDescription,
        `Error on transaction confirmation: TIMEOUT. Keep waiting if possible.`,
      );
      return true;
    }

    // If tx errors with 'REPLACEMENT_UNDERPRICED', retry the order, as the original tx may still be pending.
    if (error.code === 'REPLACEMENT_UNDERPRICED') {
      this.logger.warn(
        errorDescription,
        `Error on repriced transaction confirmation: REPLACEMENT_UNDERPRICED. Keep waiting until tx is rejected.`,
      );
      return true;
    }

    // If tx errors with 'CALL_EXCEPTION', drop the order
    if (error.code === 'CALL_EXCEPTION') {
      this.logger.info(
        errorDescription,
        `Error on repriced transaction confirmation: CALL_EXCEPTION. It has likely been relayed by another relayer. Dropping message.`,
      );
      return false; // Do not retry order confirmation
    }

    // If tx errors because of an invalid nonce, requeue the order for submission
    // NOTE: it is possible for this error to occur because of the original tx being accepted. In
    // that case, the order will error on the submitter.
    if (
      error.code === 'NONCE_EXPIRED' ||
      error.error?.message.includes('invalid sequence') //TODO is this dangerous? (any contract may include that error)
    ) {
      this.logger.info(
        errorDescription,
        `Error on transaction confirmation: nonce error. Requeue order for submission if possible.`,
      );
      order.resubmit = true;
      return false; // Do not retry order confirmation
    }

    // Unknown error on confirmation, keep waiting
    this.logger.warn(
      errorDescription,
      `Error on repriced transaction confirmation. Keep waiting if possible.`,
    );
    return true;
  }

  protected async onOrderCompletion(
    order: SubmitOrderResult,
    success: boolean,
    result: TransactionReceipt | null,
    retryCount: number,
  ): Promise<void> {
    const orderDescription = {
      originalTxHash: order.tx.hash,
      replaceTxHash: order.replaceTx?.hash,
      resubmit: order.resubmit,
      requeueCount: order.requeueCount,
      try: retryCount + 1,
    };

    if (success) {
      if (result == null) {
        this.logger.warn(
          orderDescription,
          `Transaction confirmed, but no transaction receipt returned.`,
        );
        return;
      }

      this.logger.debug(orderDescription, `Transaction confirmed.`);

      // Update the 'gas used' calculation
      const tx = order.replaceTx ?? order.tx;
      const gasProvided = tx.gasLimit.mul(
        tx.maxFeePerGas ?? tx.gasPrice ?? BigNumber.from(0),
      );
      const gasUsed = result.gasUsed.mul(result.effectiveGasPrice);
      await this.transactionHelper.registerBalanceRefund(
        gasProvided.sub(gasUsed),
      );
    } else {
      this.logger.error(orderDescription, `Transaction not confirmed.`);

      // Due to how the ProcessingQueue is currently designed, no information regarding failed
      // transactions is available at this hook. Therefore, we cannot calculate the gas used by the
      // failed transaction. As a worst-case approximation, assume all the provided gas has been
      // used (i.e. do not update the relayer's balance);
    }
  }
}
