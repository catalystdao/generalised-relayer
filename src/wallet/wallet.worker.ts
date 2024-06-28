import { JsonRpcProvider, Wallet, Provider, AbstractProvider, ZeroAddress, TransactionResponse, TransactionReceipt, TransactionRequest } from "ethers6";
import pino, { LoggerOptions } from "pino";
import { workerData, parentPort, MessagePort } from 'worker_threads';
import { tryErrorToString, wait } from "src/common/utils";
import { STATUS_LOG_INTERVAL } from "src/logger/logger.service";
import { TransactionHelper } from "./transaction-helper";
import { ConfirmQueue } from "./queues/confirm-queue";
import { WalletWorkerData } from "./wallet.service";
import { ConfirmedTransaction, GasFeeConfig, PendingTransaction, WalletTransactionOptions, WalletTransactionRequest, WalletTransactionRequestResponseMessage, BalanceConfig, WalletServiceRoutingData, WalletMessageType, WalletFeeDataMessage } from "./wallet.types";
import { SubmitQueue } from "./queues/submit-queue";


class WalletWorker {
    private readonly logger: pino.Logger;

    private readonly config: WalletWorkerData;

    private readonly provider: JsonRpcProvider;
    private readonly signer: Wallet;

    private readonly chainId: string;
    private readonly chainName: string;

    private readonly transactionHelper: TransactionHelper;

    private readonly submitQueue: SubmitQueue;
    private readonly confirmQueue: ConfirmQueue;
    private readonly newRequestsQueue: WalletTransactionRequest[] = [];

    private isStalled = false;

    private portsCount = 0;
    private readonly ports: Record<number, MessagePort> = {};


    constructor() {
        this.config = workerData as WalletWorkerData;

        this.chainId = this.config.chainId;
        this.chainName = this.config.chainName;

        this.logger = this.initializeLogger(
            this.chainId,
            this.config.loggerOptions,
        );
        this.provider = this.initializeProvider(this.config.rpc);
        this.signer = this.initializeSigner(this.config.privateKey, this.provider);

        this.transactionHelper = new TransactionHelper(
            this.getGasFeeConfig(this.config),
            this.getBalanceConfig(this.config),
            this.config.retryInterval,
            this.provider,
            this.signer,
            this.logger,
        );

        [this.submitQueue, this.confirmQueue] = this.initializeQueues(
            this.config.retryInterval,
            this.config.maxTries,
            this.config.confirmations,
            this.config.confirmationTimeout,
            this.transactionHelper,
            this.provider,
            this.signer,
            this.logger
        );

        this.initializePort();

        this.initiateIntervalStatusLog();
    }



    // Initialization helpers
    // ********************************************************************************************

    private initializeLogger(
        chainId: string,
        loggerOptions: LoggerOptions,
    ): pino.Logger {
        return pino(loggerOptions).child({
            worker: 'wallet',
            chain: chainId,
        });
    }

    private initializeProvider(rpc: string): JsonRpcProvider {
        return new JsonRpcProvider(
            rpc,
            undefined,
            { staticNetwork: true }
        )
    }

    private initializeSigner(privateKey: string, provider: Provider): Wallet {
        return new Wallet(privateKey, provider);
    }

    private initializeQueues(
        retryInterval: number,
        maxTries: number,
        confirmations: number,
        confirmationTimeout: number,
        transactionHelper: TransactionHelper,
        provider: AbstractProvider,
        signer: Wallet,
        logger: pino.Logger,
    ): [SubmitQueue, ConfirmQueue] {

        const submitQueue = new SubmitQueue(
            retryInterval,
            maxTries,
            transactionHelper,
            signer,
            logger
        );

        const confirmQueue = new ConfirmQueue(
            retryInterval,
            maxTries,
            confirmations,
            transactionHelper,
            confirmationTimeout,
            provider,
            signer,
            logger,
        );

        return [submitQueue, confirmQueue];
    }

    private getGasFeeConfig(config: WalletWorkerData): GasFeeConfig {
        return {
            gasPriceAdjustmentFactor: config.gasPriceAdjustmentFactor,
            maxAllowedGasPrice: config.maxAllowedGasPrice,
            maxFeePerGas: config.maxFeePerGas,
            maxPriorityFeeAdjustmentFactor: config.maxPriorityFeeAdjustmentFactor,
            maxAllowedPriorityFeePerGas: config.maxAllowedPriorityFeePerGas,
            priorityAdjustmentFactor: config.priorityAdjustmentFactor,
        };
    }

    private getBalanceConfig(config: WalletWorkerData): BalanceConfig {
        return {
            lowBalanceWarning: config.lowBalanceWarning,
            balanceUpdateInterval: config.balanceUpdateInterval,
        };
    }

    private initializePort(): void {
        parentPort!.on('message', (message: WalletServiceRoutingData) => {
            this.processRequest(message);
        });
    }

    private processRequest(data: WalletServiceRoutingData): void {
        const messageType = data.message.type;
        switch(messageType) {
            case WalletMessageType.TransactionRequest:
                this.addTransaction(
                    data.portId,
                    data.messageId,
                    data.message.txRequest,
                    data.message.metadata,
                    data.message.options
                )
                break;
            case WalletMessageType.GetFeeData:
                this.handleGetFeeDataRequest(
                    data.portId,
                    data.messageId,
                    data.message.priority,
                );
                break;
            default:
                this.logger.error(
                    data,
                    'Unable to process request: wallet message type unsupported.'
                );
        }
    }

    private addTransaction(
        portId: number,
        messageId: number,
        txRequest: TransactionRequest,
        metadata: any,
        options?: WalletTransactionOptions
    ): void {
        const request: WalletTransactionRequest = {
            portId,
            messageId,
            txRequest,
            metadata,
            options: options ?? {},
            requeueCount: 0
        };

        this.logger.debug(request, `Transaction received.`);

        this.newRequestsQueue.push(request);
    }

    private handleGetFeeDataRequest(
        portId: number,
        messageId: number,
        priority: boolean,
    ): void {
        const adjustedFeeData = this.transactionHelper.getAdjustedFeeData(priority);

        const feeDataMessage: WalletFeeDataMessage = {
            type: WalletMessageType.FeeData,
            priority,
            maxFeePerGas: adjustedFeeData?.maxFeePerGas ?? undefined,
            maxPriorityFeePerGas: adjustedFeeData?.maxPriorityFeePerGas ?? undefined,
            gasPrice: adjustedFeeData?.gasPrice ?? undefined,
        };

        const routingResponse: WalletServiceRoutingData = {
            portId,
            messageId,
            message: feeDataMessage,
        };

        parentPort!.postMessage(routingResponse);
    }

    private initiateIntervalStatusLog(): void {
        const logStatus = () => {
            const status = {
                capacity: this.getWalletCapacity(),
                submitQueue: this.submitQueue.size,
                submitRetryQueue: this.submitQueue.retryQueue.length,
                confirmQueue: this.confirmQueue.size,
                confirmRetryQueue: this.confirmQueue.retryQueue.length,
                isStalled: this.isStalled,
            };
            this.logger.info(status, 'Wallet status.');
        };
        setInterval(logStatus, STATUS_LOG_INTERVAL);
    }



    // Main handler
    // ********************************************************************************************
    async run(): Promise<void> {
        this.logger.info(
            `Wallet worker started.`
        );

        await this.transactionHelper.init();
        await this.confirmQueue.init();

        while (true) {
            const newOrders = await this.processNewRequestsQueue();

            await this.submitQueue.addOrders(...newOrders);
            await this.submitQueue.processOrders();
            const [
                pendingTransactions,
                invalidTransactions,
                invalidTransactionsMaxTries
            ] = this.submitQueue.getFinishedOrders();

            await this.handleInvalidTransactions(invalidTransactions, invalidTransactionsMaxTries);

            await this.confirmQueue.addOrders(...pendingTransactions);
            await this.confirmQueue.processOrders();
            const [
                confirmedTransactions,
                rejectedTransactions,
                unconfirmedTransactions
            ] = this.confirmQueue.getFinishedOrders();

            await this.handleConfirmedTransactions(confirmedTransactions);
            await this.handleRejectedTransactions(rejectedTransactions);
            await this.handleUnconfirmedTransactions(unconfirmedTransactions);

            await wait(this.config.processingInterval);
        }
    }

    private async processNewRequestsQueue(): Promise<WalletTransactionRequest[]> {
        const capacity = this.getWalletCapacity();

        let i;
        for (i = 0; i < this.newRequestsQueue.length; i++) {
            if (i + 1 > capacity) {
                break;
            }
        }

        return this.newRequestsQueue.splice(0, i);
    }

    private getWalletCapacity(): number {
        return Math.max(
            0,
            this.config.maxPendingTransactions
                - this.submitQueue.size
                - this.confirmQueue.size
        );
    }

    private async handleInvalidTransactions(
        invalidTransactions: WalletTransactionRequest[],
        invalidTransactionsMaxTries: WalletTransactionRequest[]
    ): Promise<void> {

        for (const transaction of invalidTransactionsMaxTries) {
            transaction.submissionError = new Error('Max tries reached.');
        }

        for (const transaction of [...invalidTransactions, ...invalidTransactionsMaxTries]) {

            const logDescription = {
                txRequest: transaction.txRequest,
                submissionError: tryErrorToString(transaction.submissionError)
            };

            this.logger.info(
                logDescription,
                `Unsuccessful transaction processing: transaction failed.`,
            );

            this.sendResult(transaction, undefined, undefined, transaction.submissionError);
        }

    }

    private async handleConfirmedTransactions(
        confirmedTransactions: ConfirmedTransaction[],
    ): Promise<void> {

        for (const transaction of confirmedTransactions) {
            // Register the gas cost used
            //TODO this should be done before the tx is submitted
            const txReceipt = transaction.txReceipt;
            const gasCost = txReceipt.gasUsed * txReceipt.gasPrice;
            await this.transactionHelper.registerBalanceUse(gasCost);

            const logDescription = {
                txHash: transaction.txReceipt.hash,
                blockHash: transaction.txReceipt.blockHash,
                blockNumber: transaction.txReceipt.blockNumber
            };

            this.logger.info(
                logDescription,
                `Successful transaction processing: transaction confirmed.`,
            );

            this.sendResult(transaction, transaction.tx, transaction.txReceipt);
        }
    }

    private async handleRejectedTransactions(
        rejectedTransactions: PendingTransaction[],
    ): Promise<void> {

        for (const transaction of rejectedTransactions) {

            // Currently, the gas used by failed transactions is not taken into account for the
            // relayer gas estimate.

            const confirmationError = transaction.confirmationError;

            const logDescription = {
                txHash: transaction.tx.hash,
                replaceTxHash: transaction.txReplacement?.hash,
                requeueCount: transaction.requeueCount,
                confirmationError: tryErrorToString(confirmationError),
            };

            // If tx errors because of an invalid nonce, requeue the order for submission
            // TODO: is it possible for this error to occur because of the original tx being accepted (edge case). This should never happen.
            if (
                this.isNonceExpiredError(confirmationError, true)   // NOTE: if a 'underpriced' error reaches this point, it means that the original transaction must have errored in some way
                && transaction.requeueCount < this.config.maxTries
                && transaction.options.retryOnNonceConfirmationError != false
            ) {
                this.logger.info(
                    logDescription,
                    `Nonce error on transaction confirmation: requeuing transaction.`,
                );
                const requeueRequest: WalletTransactionRequest = {
                    portId: transaction.portId,
                    messageId: transaction.messageId,
                    txRequest: transaction.txRequest,
                    metadata: transaction.metadata,
                    options: transaction.options,
                    requeueCount: transaction.requeueCount + 1,
                };

                await this.submitQueue.addOrders(requeueRequest);
            } else {
                this.logger.info(
                    logDescription,
                    `Unsuccessful transaction processing: transaction rejected.`,
                );

                this.sendResult(transaction, transaction.tx, undefined, undefined, transaction.confirmationError);
            }
        }
    }

    private async handleUnconfirmedTransactions(
        unconfirmedTransactions: PendingTransaction[],
    ): Promise<void> {
        for (const transaction of unconfirmedTransactions) {
            const receipt = await this.cancelTransaction(transaction.tx);

            const error = new Error('Transaction cancelled.');
            this.sendResult(transaction, transaction.tx, receipt ?? undefined, undefined, error);
        }
    }

    // This function does not return until the transaction of the given nonce is mined!
    private async cancelTransaction(baseTx: TransactionResponse): Promise<TransactionReceipt | null> {
        const cancelTxNonce = baseTx.nonce;

        for (let i = 0; i < this.config.maxTries; i++) {

            try {
                // NOTE: cannot use the 'transactionHelper' for querying of the transaction nonce, as the
                // helper takes into account the 'pending' transactions.
                const latestNonce = await this.signer.getNonce('latest');

                if (latestNonce > cancelTxNonce) {
                    return null;
                }

                this.logger.info(
                    { cancelTxNonce },
                    'Submitting transaction cancellation'
                );

                await this.transactionHelper.updateFeeData();

                const tx = await this.signer.sendTransaction({
                    nonce: cancelTxNonce,
                    to: ZeroAddress,
                    data: '0x',
                    ...this.transactionHelper.getIncreasedFeeDataForTransaction(baseTx),
                });

                const receipt = await tx.wait(
                    this.config.confirmations,
                    this.config.confirmationTimeout,
                );

                if (receipt != null) {  //NOTE: receipt == null should never happen
                    await this.transactionHelper.registerBalanceUse(
                        receipt.gasUsed * receipt.gasPrice,
                    );
                }

                // Transaction cancelled
                return receipt;
            } catch (error) {
                this.logger.warn(
                    { cancelTxNonce, error },
                    'Error on transaction cancellation.'
                );
                // Continue trying to cancel the transaction
            }

            await wait(this.config.retryInterval);
        }

        this.isStalled = true;
        while (true) {
            this.logger.warn(
                { nonce: cancelTxNonce },
                `Wallet stalled. Waiting until pending transaction is resolved.`,
            );

            await wait(this.config.confirmationTimeout);

            // NOTE: cannot use the 'transactionHelper' for querying of the transaction nonce, as the
            // helper takes into account the 'pending' transactions.
            const latestNonce = await this.signer.getNonce('latest');

            if (latestNonce > cancelTxNonce) {
                this.logger.info(
                    { nonce: cancelTxNonce },
                    `Wallet resumed after stall recovery.`,
                );
                this.isStalled = false;
                return null;
            }
        }
    }

    private sendResult(
        request: WalletTransactionRequest,
        tx?: TransactionResponse,
        txReceipt?: TransactionReceipt,
        submissionError?: any,
        confirmationError?: any,
    ): void {

        const transactionResponse: WalletTransactionRequestResponseMessage = {
            type: WalletMessageType.TransactionRequestResponse,
            txRequest: request.txRequest,
            metadata: request.metadata,
            tx,
            txReceipt,
            submissionError: tryErrorToString(submissionError),
            confirmationError: tryErrorToString(confirmationError),
        }

        const routingResponse: WalletServiceRoutingData = {
            portId: request.portId,
            messageId: request.messageId,
            message: transactionResponse,
        }

        parentPort!.postMessage(routingResponse);
    }

    private isNonceExpiredError(error: any, includeUnderpricedError?: boolean): boolean {
        return (
            error?.code === 'NONCE_EXPIRED' ||
            (includeUnderpricedError && error?.code === 'REPLACEMENT_UNDERPRICED') ||
            error?.error?.message.includes('invalid sequence') //TODO is this dangerous? (any contract may include that error)
        );
    }

}

void new WalletWorker().run();
