import { WETH9__factory } from '../../contracts/factories/WETH9__factory';
import { AbiCoder, JsonRpcProvider, parseEther, Wallet } from "ethers6";
import { strict as assert } from 'assert';
import { CatalystVaultCommon__factory } from '../../contracts/factories/CatalystVaultCommon__factory';
import { config, deploymentConfig } from '../config';

export const defaultAbiCoder = AbiCoder.defaultAbiCoder();
function encode65ByteAddress(
    address: string
): string {
    assert(address.length == 2 + 20 * 2);
    return `0x14${address.slice(2).padStart(128, '0')}`;
}

async function setAccountBalance(
    provider: JsonRpcProvider,
    account: string,
    ethBalance: bigint,
): Promise<any> {
    return provider.send('anvil_setBalance', [
        account,
        encodeNumber(ethBalance),
    ]);
}
function encodeNumber(value: number | bigint): string {
    return add0X(value.toString(16));
}

function add0X(val: string): string {
    return `0x${val}`;
}

export async function fundWallets() {
    if (deploymentConfig.privateKey) {

        const wallet = new Wallet(deploymentConfig.privateKey);
        const providerA = new JsonRpcProvider(config.chains[0]?.rpc);
        const providerB = new JsonRpcProvider(config.chains[1]?.rpc);
        const fundAmountEth = 10000000;
        const fundAmount = parseEther(fundAmountEth.toString());
        const wrapShare = 0.75;
        const wrapAmountEth = Math.floor(fundAmountEth * wrapShare);
        const wrapAmount = parseEther(wrapAmountEth.toString());
        const vaultA = CatalystVaultCommon__factory.connect(deploymentConfig.catalystVault, providerA);
        const vaultB = CatalystVaultCommon__factory.connect(deploymentConfig.catalystVault, providerB);

        const chainBIdentifier = defaultAbiCoder.encode(['uint256'], [config.chains[1]?.chainId]);
        const encodedVaultBAddress = encode65ByteAddress(deploymentConfig.catalystVault);
        assert(await vaultA._vaultConnection(chainBIdentifier, encodedVaultBAddress) === true);

        const chainAIdentifier = defaultAbiCoder.encode(['uint256'], [config.chains[0]?.chainId]);
        const encodedVaultAAddress = encode65ByteAddress(deploymentConfig.catalystVault);
        assert(await vaultB._vaultConnection(chainAIdentifier, encodedVaultAAddress) === true);


        const assetA = await vaultA._tokenIndexing(0);
        const assetB = await vaultB._tokenIndexing(0);

        const wethAContract = WETH9__factory.connect(assetA, providerA);
        const wethBContract = WETH9__factory.connect(assetB, providerB);

        await Promise.all([
            setAccountBalance(providerA, wallet.address, fundAmount),
            setAccountBalance(providerB, wallet.address, fundAmount)
        ]);

        const signerA = wallet.connect(providerA);
        const signerB = wallet.connect(providerB);

        const wrapTxA = await wethAContract.connect(signerA).deposit({ value: wrapAmount });
        const wrapTxB = await wethBContract.connect(signerB).deposit({ value: wrapAmount });

        await Promise.all([wrapTxA.wait(), wrapTxB.wait()]);

        const approveTxA = await wethAContract.connect(signerA).approve(deploymentConfig.catalystVault, 2n ** 256n - 1n);
        const approveTxB = await wethBContract.connect(signerB).approve(deploymentConfig.catalystVault, 2n ** 256n - 1n);
        await Promise.all([approveTxA.wait(), approveTxB.wait()]);
    }
}