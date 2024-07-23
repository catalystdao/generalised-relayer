import { AbstractProvider, FeeData, TransactionResponse, Wallet } from 'ethers6';
import pino from 'pino';
import { BalanceConfig, GasFeeConfig, GasFeeOverrides } from './wallet.types';

const DECIMAL_BASE = 10000;
const DECIMAL_BASE_BIG_INT = BigInt(DECIMAL_BASE);

export const DEFAULT_PRIORITY_ADJUSTMENT_FACTOR = 1.1;
export const MAX_GAS_PRICE_ADJUSTMENT_FACTOR = 5;

export class TransactionHelper {
    private transactionNonce: number = -1;
    private feeData: FeeData | undefined;

    private priorityAdjustmentFactor: bigint = 0n;

    // Config for legacy transactions
    private gasPriceAdjustmentFactor: bigint | undefined;
    private maxAllowedGasPrice: bigint | undefined;

    // Config for EIP 1559 transactions
    private maxFeePerGas: bigint | undefined;
    private maxPriorityFeeAdjustmentFactor: bigint | undefined;
    private maxAllowedPriorityFeePerGas: bigint | undefined;

    // Balance config
    private walletBalance: bigint = 0n;
    private transactionsSinceLastBalanceUpdate: number = 0;
    private isBalanceLow: boolean = false;

    private lowBalanceWarning: bigint | undefined;
    private balanceUpdateInterval: number = -1;

    constructor(
        gasFeeConfig: GasFeeConfig,
        balanceConfig: BalanceConfig,
        private readonly retryInterval: number,
        private readonly provider: AbstractProvider,
        private readonly wallet: Wallet,
        private readonly logger: pino.Logger,
    ) {
        this.loadGasFeeConfig(gasFeeConfig);
        this.loadBalanceConfig(balanceConfig);
    }

    private loadGasFeeConfig(config: GasFeeConfig): void {
        const {
            gasPriceAdjustmentFactor,
            maxPriorityFeeAdjustmentFactor,
            priorityAdjustmentFactor,
        } = config;

        // Config for legacy transactions
        this.maxAllowedGasPrice = config.maxAllowedGasPrice;

        if (gasPriceAdjustmentFactor != undefined) {
            if (gasPriceAdjustmentFactor > MAX_GAS_PRICE_ADJUSTMENT_FACTOR) {
                throw new Error(
                    `Failed to load gas fee configuration. 'gasPriceAdjustmentFactor' is larger than the allowed (${MAX_GAS_PRICE_ADJUSTMENT_FACTOR})`,
                );
            }

            this.gasPriceAdjustmentFactor = BigInt(
                gasPriceAdjustmentFactor * DECIMAL_BASE,
            );
        }


        // Config for EIP 1559 transactions
        this.maxFeePerGas = config.maxFeePerGas;
        this.maxAllowedPriorityFeePerGas = config.maxAllowedPriorityFeePerGas;

        if (maxPriorityFeeAdjustmentFactor != undefined) {
            if (maxPriorityFeeAdjustmentFactor > MAX_GAS_PRICE_ADJUSTMENT_FACTOR) {
                throw new Error(
                    `Failed to load gas fee configuration. 'maxPriorityFeeAdjustmentFactor' is larger than the allowed (${MAX_GAS_PRICE_ADJUSTMENT_FACTOR})`,
                );
            }

            this.maxPriorityFeeAdjustmentFactor = BigInt(
                maxPriorityFeeAdjustmentFactor * DECIMAL_BASE,
            );
        }


        // Priority config
        if (priorityAdjustmentFactor != undefined) {
            if (
                priorityAdjustmentFactor > MAX_GAS_PRICE_ADJUSTMENT_FACTOR ||
                priorityAdjustmentFactor < 1
            ) {
                throw new Error(
                    `Failed to load gas fee configuration. 'priorityAdjustmentFactor' is larger than the allowed (${MAX_GAS_PRICE_ADJUSTMENT_FACTOR}) or less than 1.`,
                );
            }

            this.priorityAdjustmentFactor = BigInt(
                priorityAdjustmentFactor * DECIMAL_BASE,
            );
        } else {
            this.logger.info(
                `Priority adjustment factor unset. Defaulting to ${DEFAULT_PRIORITY_ADJUSTMENT_FACTOR}`,
            );

            this.priorityAdjustmentFactor = BigInt(
                DEFAULT_PRIORITY_ADJUSTMENT_FACTOR * DECIMAL_BASE,
            );
        }
    }

    private loadBalanceConfig(config: BalanceConfig): void {
        this.lowBalanceWarning = config.lowBalanceWarning;
        this.balanceUpdateInterval = config.balanceUpdateInterval;
    }

    async init(): Promise<void> {
        await this.updateTransactionNonce();
        await this.updateFeeData();
        await this.updateWalletBalance();
    }

    /**
     * Update the transaction nonce of the signer.
     */
    async updateTransactionNonce(): Promise<void> {
        let i = 1;
        while (true) {
            try {
                this.transactionNonce = await this.wallet.getNonce('pending'); //TODO 'pending' may not be supported
                break;
            } catch (error) {
                // Continue trying indefinitely. If the transaction count is incorrect, no transaction will go through.
                this.logger.warn(
                    { try: i, address: this.wallet.address },
                    `Failed to update nonce.`,
                );
                await new Promise((r) => setTimeout(r, this.retryInterval));
            }

            i++;
        }
    }

    getTransactionNonce(): number {
        return this.transactionNonce;
    }

    increaseTransactionNonce(): void {
        this.transactionNonce++;
    }

    async registerBalanceUse(amount: bigint): Promise<void> {
        this.transactionsSinceLastBalanceUpdate++;

        const newWalletBalance = this.walletBalance - amount;
        if (newWalletBalance < 0n) {
            this.walletBalance = 0n;
        } else {
            this.walletBalance = newWalletBalance;
        }

        if (
            this.lowBalanceWarning != undefined &&
            !this.isBalanceLow && // Only trigger update if the current saved state is 'balance not low' (i.e. crossing the boundary)
            this.walletBalance < this.lowBalanceWarning
        ) {
            await this.updateWalletBalance();
        }
    }

    async registerBalanceRefund(amount: bigint): Promise<void> {
        this.walletBalance = this.walletBalance + amount;
    }

    async runBalanceCheck(): Promise<void> {
        if (
            this.isBalanceLow ||
            this.transactionsSinceLastBalanceUpdate > this.balanceUpdateInterval
        ) {
            await this.updateWalletBalance();
        }
    }

    async updateWalletBalance(): Promise<void> {
        let i = 0;
        let walletBalance;
        while (walletBalance == undefined) {
            try {
                walletBalance = await this.provider.getBalance(this.wallet.address, 'pending');
            } catch {
                i++;
                this.logger.warn(
                    { account: this.wallet.address, try: i },
                    'Failed to update account balance. Worker locked until successful update.',
                );
                await new Promise((r) => setTimeout(r, this.retryInterval));
                // Continue trying
            }
        }

        this.walletBalance = walletBalance;
        this.transactionsSinceLastBalanceUpdate = 0;

        if (this.lowBalanceWarning != undefined) {
            const isBalanceLow = this.walletBalance < this.lowBalanceWarning;
            if (isBalanceLow != this.isBalanceLow) {
                this.isBalanceLow = isBalanceLow;
                const balanceInfo = {
                    balance: this.walletBalance,
                    lowBalanceWarning: this.lowBalanceWarning,
                    account: this.wallet.address,
                };
                if (isBalanceLow) this.logger.warn(balanceInfo, 'Wallet balance low.');
                else this.logger.info(balanceInfo, 'Wallet funded.');
            }
        }
    }

    async updateFeeData(): Promise<void> {
        try {
            this.feeData = await this.provider.getFeeData();
        } catch {
            // Continue with stale fee data.
        }
    }

    getCachedFeeData(): FeeData | undefined {
        return this.feeData;
    }

    getAdjustedFeeData(
        priority?: boolean,
    ): FeeData | undefined {
        const feeData = {...this.feeData};
        if (feeData == undefined) {
            return undefined;
        }

        // Override 'maxFeePerGas' if it is specified on the config.
        if (this.maxFeePerGas) {
            feeData.maxFeePerGas = this.maxFeePerGas;
        }

        // Adjust the 'maxPriorityFeePerGas' if present.
        if (feeData.maxPriorityFeePerGas != undefined) {
            // Adjust the 'maxPriorityFeePerGas' by the adjustment factor
            if (this.maxPriorityFeeAdjustmentFactor != undefined) {
                feeData.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas
                    * this.maxPriorityFeeAdjustmentFactor
                    / DECIMAL_BASE_BIG_INT;
            }

            // Apply the max allowed 'maxPriorityFeePerGas'
            if (
                this.maxAllowedPriorityFeePerGas != undefined &&
                this.maxAllowedPriorityFeePerGas < feeData.maxPriorityFeePerGas
            ) {
                feeData.maxPriorityFeePerGas = this.maxAllowedPriorityFeePerGas;
            }
        }

        // Adjust the 'gasPrice' if present.
        if (feeData.gasPrice) {
            // Adjust the 'gasPrice' by the adjustment factor
            if (this.gasPriceAdjustmentFactor != undefined) {
                feeData.gasPrice = feeData.gasPrice
                    * this.gasPriceAdjustmentFactor
                    / DECIMAL_BASE_BIG_INT;
            }

            // Apply the max allowed 'gasPrice'
            if (
                this.maxAllowedGasPrice != undefined &&
                this.maxAllowedGasPrice < feeData.gasPrice
            ) {
                feeData.gasPrice = this.maxAllowedGasPrice;
            }
        }

        // Apply the 'priority' adjustment factor
        if (priority) {
            if (feeData.maxFeePerGas != undefined) {
                feeData.maxFeePerGas = feeData.maxFeePerGas
                    *this.priorityAdjustmentFactor
                    / DECIMAL_BASE_BIG_INT;
            }

            if (feeData.maxPriorityFeePerGas != undefined) {
                feeData.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas
                    *this.priorityAdjustmentFactor
                    / DECIMAL_BASE_BIG_INT;
            }

            if (feeData.gasPrice != undefined) {
                feeData.gasPrice = feeData.gasPrice
                    * this.priorityAdjustmentFactor
                    / DECIMAL_BASE_BIG_INT;
            }
        }

        return new FeeData(
            feeData.gasPrice,
            feeData.maxFeePerGas,
            feeData.maxPriorityFeePerGas
        );
    }

    getFeeDataForTransaction(priority?: boolean): GasFeeOverrides {
        const adjustedFeeData = this.getAdjustedFeeData(priority);
        if (adjustedFeeData == undefined) {
            return {};
        }

        if (adjustedFeeData.maxPriorityFeePerGas != undefined) {
            // Set fee data for EIP 1559 transactions
            return {
                maxFeePerGas: adjustedFeeData.maxFeePerGas ?? undefined,
                maxPriorityFeePerGas: adjustedFeeData.maxPriorityFeePerGas,
            };
        } else {
            return {
                gasPrice: adjustedFeeData.gasPrice ?? undefined,
            };
        }
    }

    getIncreasedFeeDataForTransaction(
        originalTx: TransactionResponse,
    ): GasFeeOverrides {
        const priorityFees = this.getFeeDataForTransaction(true);

        const gasPrice = this.getLargestFee(
            originalTx.gasPrice,
            priorityFees.gasPrice,
        );
        const maxFeePerGas = this.getLargestFee(
            originalTx.maxFeePerGas,
            priorityFees.maxFeePerGas,
        );
        const maxPriorityFeePerGas = this.getLargestFee(
            originalTx.maxPriorityFeePerGas,
            priorityFees.maxPriorityFeePerGas,
        );

        if (
            gasPrice == undefined &&
            maxFeePerGas == undefined &&
            maxPriorityFeePerGas == undefined
        ) {
            this.logger.warn(
                { tx: originalTx },
                `Failed to compute increased fee data for tx. All fee values returned 'undefined'.`,
            );
        }

        return {
            gasPrice,
            maxFeePerGas,
            maxPriorityFeePerGas,
        };
    }

    // If 'previousFee' exists, return the largest of:
    // - previousFee * priorityAdjustmentFactor
    // - priorityFee
    private getLargestFee(
        previousFee: bigint | null | undefined,
        priorityFee: bigint | null | undefined,
    ): bigint | undefined {
        if (previousFee != undefined) {
            const increasedPreviousFee = previousFee
                * this.priorityAdjustmentFactor
                / DECIMAL_BASE_BIG_INT;

            if (priorityFee == undefined || increasedPreviousFee > priorityFee) {
                return increasedPreviousFee;
            } else {
                return priorityFee;
            }
        }

        return undefined;
    }
}
