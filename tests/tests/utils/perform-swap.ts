import { Wallet, JsonRpcProvider, AbiCoder, ContractTransactionResponse } from 'ethers6';
import { strict as assert } from 'assert';
import { CatalystVaultCommon__factory } from '../../contracts';
import { config, deploymentConfig } from '../../config/config';

const defaultAbiCoder = AbiCoder.defaultAbiCoder();

export interface Incentive {
    maxGasDelivery: number;
    maxGasAck: number;
    refundGasTo: string;
    priceOfDeliveryGas: string;
    priceOfAckGas: string;
    targetDelta: number;
}

const chainDefinitions = {
    localA: {
        chainId: '1',
        name: 'local a (anvil)',
        rpc: config.chains[0]?.rpc,
        catalystVault: deploymentConfig.catalystVault,
    },
    localB: {
        chainId: '2',
        name: 'local b (anvil)',
        rpc: config.chains[1]?.rpc,
        catalystVault: deploymentConfig.catalystVault,
    },
};



function encode65ByteAddress(address: string): string {
    assert(address.length == 2 + 20 * 2);
    return `0x14${address.slice(2).padStart(128, '0')}`;
}

export async function performSwap(
    wallet: Wallet,
    transaction: Transaction,
): Promise<ContractTransactionResponse> {
    const direction = transaction.direction;
    const chainA = chainDefinitions.localA;
    const chainB = chainDefinitions.localB;

    const providerA = new JsonRpcProvider(chainA.rpc);
    const providerB = new JsonRpcProvider(chainB.rpc);

    const vaultA = CatalystVaultCommon__factory.connect(chainA.catalystVault, providerA);
    const vaultB = CatalystVaultCommon__factory.connect(chainB.catalystVault, providerB);

    const assetA = await vaultA._tokenIndexing(0);
    const assetB = await vaultB._tokenIndexing(0);

    const provider = direction ? providerA : providerB;
    const fromVault = direction ? vaultA : vaultB;
    const fromAsset = direction ? assetA : assetB;

    const chainIdentifier = direction
        ? defaultAbiCoder.encode(['uint256'], [chainB.chainId])
        : defaultAbiCoder.encode(['uint256'], [chainA.chainId]);
    const encodedToVaultAddress = direction
        ? encode65ByteAddress(chainB.catalystVault)
        : encode65ByteAddress(chainA.catalystVault);
    const toAssetIndex = direction ? 0 : 0;

    const signer = wallet.connect(provider);

    const swapRecipientAddress = wallet.address;
    const swapRecipientEncodedAddress = encode65ByteAddress(swapRecipientAddress);

    const underwriteIncentiveX16 = 11000n;

    try {
        const tx = await fromVault.connect(signer).sendAsset(
            {
                chainIdentifier,
                toVault: encodedToVaultAddress,
                toAccount: swapRecipientEncodedAddress,
                incentive: {
                    ...transaction.incentive,
                    priceOfDeliveryGas: BigInt(transaction.incentive.priceOfDeliveryGas),
                    priceOfAckGas: BigInt(transaction.incentive.priceOfAckGas),
                },
                deadline: 0,
            },
            fromAsset,
            toAssetIndex,
            BigInt(transaction.swapAmount),
            0,
            wallet.address,
            underwriteIncentiveX16,
            '0x',
            {
                value: BigInt(transaction.incentivePayment),
                gasLimit: 1000000n,
            },
        );

        await tx.wait();
        return tx;
    } catch (error) {
        throw new Error('Transaction failed: ' + error);
    }
}

export type Transaction = {
    direction: boolean;
    swapAmount: string;
    incentivePayment: string;
    incentive: Incentive;
};
