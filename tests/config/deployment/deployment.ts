import { ERC20__factory } from '../../contracts/factories/ERC20__factory';
import { WETH9__factory } from '../../contracts/factories/WETH9__factory';
import { WETH9 } from '../../contracts/WETH9';
import { CatalystMathVol__factory } from '../../contracts/factories/CatalystMathVol__factory';
import { CatalystVaultVolatile__factory } from '../../contracts/factories/CatalystVaultVolatile__factory';
import { CatalystChainInterface__factory } from '../../contracts/factories/CatalystChainInterface__factory';
import { CatalystFactory__factory } from '../../contracts/factories/CatalystFactory__factory';
import { AbiCoder, AddressLike, BigNumberish, BytesLike, isAddressable, JsonRpcProvider, parseEther, Wallet, ZeroAddress } from "ethers6";
import { IncentivizedMockEscrow } from "../../contracts/IncentivizedMockEscrow";
import { CatalystFactory } from '../../contracts/CatalystFactory';
import { CatalystChainInterface } from '../../contracts/CatalystChainInterface';
import { CatalystMathVol } from '../../contracts/CatalystMathVol';
import { CatalystVaultVolatile } from '../../contracts/CatalystVaultVolatile';
import { IncentivizedMockEscrow__factory } from '../../contracts/factories/IncentivizedMockEscrow__factory';
import { config, deploymentConfig } from '../config';
import { wait } from '../../../src/common/utils';

// Constants
export const DEFAULT_COST_OF_MESSAGE = 0n;
export const DEFAULT_PROOF_PERIOD = 0;

// Configuration
const chainAId = 1;
const rpcA = config.chains[0]?.rpc;
const providerA = new JsonRpcProvider(rpcA);
const deployerA = new Wallet(deploymentConfig.privateKey, providerA);

const chainBId = 2;
const rpcB = config.chains[1]?.rpc;
const providerB = new JsonRpcProvider(rpcB);
const deployerB = new Wallet(deploymentConfig.privateKey, providerB);

const fundAmountEth = 10000;
const fundAmount = parseEther(fundAmountEth.toString());
const wrapShare = 0.75;
const wrapAmountEth = Math.floor(fundAmountEth * wrapShare);
const wrapAmount = parseEther(wrapAmountEth.toString());

export const defaultAbiCoder = AbiCoder.defaultAbiCoder();

//Interfaces +++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++

export interface CatalystContractsAddresses {
    factoryAddress: string,
    volatileVaultTemplateAddress: string,
    chainInterfaceAddress: string
}

export interface CatalystContracts extends CatalystContractsAddresses {
    factory: CatalystFactory,
    volatileVaultTemplate: CatalystVaultVolatile,
    chainInterface: CatalystChainInterface,
}

export interface ChainDeploymentAddresses {
    chainId: number,
    chainIdBytes: BytesLike,
    escrowAddress: string,
    wethAddress: string,
    catalyst: CatalystContractsAddresses,
}

export interface ChainDeployment extends ChainDeploymentAddresses {
    escrow: IncentivizedMockEscrow,
    weth: WETH9,
    catalyst: CatalystContracts,
}

//Helpers Functions +++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++

export async function setAccountBalance(
    provider: JsonRpcProvider,
    account: string,
    ethBalance: bigint,
): Promise<any> {
    return provider.send('anvil_setBalance', [
        account,
        encodeNumber(ethBalance),
    ]);
}
export function add0X(val: string): string {
    return `0x${val}`;
}

export function encodeNumber(value: number | bigint): string {
    return add0X(value.toString(16));
}


//Deployment Functions +++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++

export async function deployMockEscrow(
    deployer: Wallet,
    uniqueChainIndex: BytesLike,
    sendLostGasTo?: AddressLike,
    signer?: AddressLike,
    costOfMessages_?: BigNumberish,
    proofPeriod?: BigNumberish,
): Promise<IncentivizedMockEscrow> {

    const mockEscrow = new IncentivizedMockEscrow__factory(deployer);
    const deployResponse = await mockEscrow.deploy(
        sendLostGasTo ?? ZeroAddress,
        uniqueChainIndex,
        signer ?? deployer.address,
        costOfMessages_ ?? DEFAULT_COST_OF_MESSAGE,
        proofPeriod ?? DEFAULT_PROOF_PERIOD
    );

    await deployResponse.waitForDeployment();

    return deployResponse;
}

export async function deployCatalystFactory(
    deployer: Wallet,
    factoryOwner?: AddressLike,
): Promise<CatalystFactory> {
    const factory = new CatalystFactory__factory(deployer);
    const deployResponse = await factory.deploy(
        factoryOwner ?? deployer.address,
    );

    await deployResponse.waitForDeployment();

    return deployResponse;

}

export async function deployChainInterface(
    deployer: Wallet,
    garpAddress: AddressLike,
    interfaceOwner?: AddressLike,
): Promise<CatalystChainInterface> {
    const chainInterface = new CatalystChainInterface__factory(deployer);
    const deployResponse = await chainInterface.deploy(
        garpAddress,
        interfaceOwner ?? deployer.address,
    );

    await deployResponse.waitForDeployment();

    return deployResponse;
}

export async function deployCatalystMathVol(
    deployer: Wallet,
): Promise<CatalystMathVol> {
    const catalystMathVol = new CatalystMathVol__factory(deployer);
    const deployResponse = await catalystMathVol.deploy();
    await deployResponse.waitForDeployment();
    return deployResponse;
}

export async function deployCatalystVaultVolatile(
    deployer: Wallet,
    factoryAddress: AddressLike,
    mathlibAddress: AddressLike
): Promise<CatalystVaultVolatile> {
    const catalystVaultVolatile = new CatalystVaultVolatile__factory(deployer);
    const deployResponse = await catalystVaultVolatile.deploy(
        factoryAddress,
        mathlibAddress,
    );
    await deployResponse.waitForDeployment();
    return deployResponse;
}

export async function deployWETH(
    deployer: Wallet
): Promise<WETH9> {
    const weth9 = new WETH9__factory(deployer);
    const deployResponse = await weth9.deploy();
    await deployResponse.waitForDeployment();
    return deployResponse;
}

export async function deployVault(
    deployer: Wallet,
    factory: CatalystFactory,
    vaultTemplateAddress: AddressLike,
    chainInterfaceAddress: AddressLike,
    assets: AddressLike[],
    assetsAmounts: bigint[],
    weights: bigint[],
    amplification: bigint,
    vaultFee: bigint,
    vaultName?: string,
    vaultSymbol?: string,
): Promise<string> {

    // Set approvals
    for (let i = 0; i < assets.length; i++) {
        const asset = assets[i]!;
        const assetAmount = assetsAmounts[i];

        if (assetAmount == undefined) {
            throw new Error('Asset amount not provided for asset.');
        }

        const tokenContract = ERC20__factory.connect(
            isAddressable(asset) ? await asset.getAddress() : asset.toString(),
            deployer
        );
        const approveTx = await tokenContract.approve(factory, assetAmount);
        await approveTx.wait();
    }

    // Deploy vault
    const deployVaultTx = await factory.connect(deployer).deployVault(
        vaultTemplateAddress,
        assets,
        assetsAmounts,
        weights,
        amplification,
        vaultFee,
        vaultName ?? 'Vault',
        vaultSymbol ?? 'V',
        chainInterfaceAddress,
        {
            gasLimit: 1000000n
        }
    );

    const deployResult = await deployVaultTx.wait();

    if (deployResult == null) {
        throw new Error('No result on vault deploy.');
    }

    const factoryInterface = CatalystFactory__factory.createInterface();
    const targetEventHash = factoryInterface
        .getEvent('VaultDeployed')
        .topicHash
        .toLowerCase();

    const deployLog = deployResult.logs.find((log) => {
        return log.topics[0]?.toLowerCase() == targetEventHash;
    });

    if (deployLog == undefined) {
        throw new Error('Error on vault deployment')
    }

    const parsedDeployLog = factoryInterface.parseLog(deployLog);

    return parsedDeployLog!.args['vaultAddress'];
}

export async function deployCatalyst(
    deployer: Wallet,
    escrowAddress: AddressLike,
): Promise<CatalystContracts> {

    const factory = await deployCatalystFactory(
        deployer,
    );

    const catalystMathVol = await deployCatalystMathVol(
        deployer,
    );
    const volatileVaultTemplate = await deployCatalystVaultVolatile(
        deployer,
        factory,
        catalystMathVol,
    );

    const chainInterface = await deployChainInterface(
        deployer,
        escrowAddress,
        deployer
    );

    return {
        factory,
        factoryAddress: await factory.getAddress(),
        volatileVaultTemplate,
        volatileVaultTemplateAddress: await volatileVaultTemplate.getAddress(),
        chainInterface,
        chainInterfaceAddress: await chainInterface.getAddress(),
    };
}

export function getCatalystAddresses(
    catalyst: CatalystContracts
): CatalystContractsAddresses {
    return {
        factoryAddress: catalyst.factoryAddress,
        volatileVaultTemplateAddress: catalyst.volatileVaultTemplateAddress,
        chainInterfaceAddress: catalyst.chainInterfaceAddress,
    }
}

export async function initializeChainDeployments(
    chainId: number,
    deployer: Wallet,
    deployerFundAmount = parseEther("10000"),
    deployerWrapAmount = parseEther("100"),
): Promise<ChainDeployment> {
    const chainIdBytes = add0X(chainId.toString(16).padStart(64, '0'));
    await setAccountBalance(
        deployer.provider! as JsonRpcProvider,  //TODO handle this in a better way?
        deployer.address,
        deployerFundAmount
    );

    await wait(1000);

    const escrow = await deployMockEscrow(
        deployer,
        chainIdBytes,
    );

    const weth = await deployWETH(deployer);

    await wait(1000);

    const wrapTx = await weth.deposit({ value: deployerWrapAmount });
    await wrapTx.wait();

    const catalyst = await deployCatalyst(
        deployer,
        escrow,
    );

    await wait(1000);

    return {
        chainId,
        chainIdBytes,
        escrow,
        escrowAddress: await escrow.getAddress(),
        weth,
        wethAddress: await weth.getAddress(),
        catalyst,
    }
}

export function getChainDeploymentAddresses(
    deployment: ChainDeployment,
): ChainDeploymentAddresses {
    return {
        chainId: deployment.chainId,
        chainIdBytes: deployment.chainIdBytes,
        escrowAddress: deployment.escrowAddress,
        wethAddress: deployment.wethAddress,
        catalyst: getCatalystAddresses(deployment.catalyst),
    }
}

export async function connectInterfaces(
    deploymentA: ChainDeployment,
    deploymentB: ChainDeployment,
): Promise<void> {

    // Connect interfaces
    const txA = await deploymentA.catalyst.chainInterface.connectNewChain(
        deploymentB.chainIdBytes,
        add0X(`14${deploymentB.catalyst.chainInterfaceAddress.slice(2).padStart(128, '0')}`),
        add0X((await deploymentB.escrow.getAddress()).slice(2).padStart(64, '0')),
        {
            gasLimit: 1000000n
        }
    );

    const txB = await deploymentB.catalyst.chainInterface.connectNewChain(
        deploymentA.chainIdBytes,
        add0X(`14${deploymentA.catalyst.chainInterfaceAddress.slice(2).padStart(128, '0')}`),
        add0X((await deploymentA.escrow.getAddress()).slice(2).padStart(64, '0')),
        {
            gasLimit: 1000000n
        }
    );

    await Promise.all([txA.wait(), txB.wait()]);
}

export async function deployBasicVault(
    deployer: Wallet,
    deployment: ChainDeployment,
    initialBalance: bigint,
): Promise<string> {
    return deployVault(
        deployer,
        deployment.catalyst.factory,
        deployment.catalyst.volatileVaultTemplate,
        deployment.catalyst.chainInterface,
        [deployment.weth],
        [initialBalance],
        [1n],
        1000000000000000000n,
        0n
    );
}

export async function connectVaults(
    vaultA: CatalystVaultVolatile,
    chainAId: BytesLike,
    vaultB: CatalystVaultVolatile,
    chainBId: BytesLike,
): Promise<void> {

    const vaultAAddress = await vaultA.getAddress();
    const encodedVaultAAddress = add0X(`14${vaultAAddress.slice(2).padStart(128, '0')}`);

    const vaultBAddress = await vaultB.getAddress();
    const encodedVaultBAddress = add0X(`14${vaultBAddress.slice(2).padStart(128, '0')}`);

    const vaultASetConnectionPromise = vaultA.setConnection(
        chainBId,
        encodedVaultBAddress,
        true
    );
    const vaultBSetConnectionPromise = vaultB.setConnection(
        chainAId,
        encodedVaultAAddress,
        true
    );

    const [txA, txB] = await Promise.all([
        vaultASetConnectionPromise,
        vaultBSetConnectionPromise
    ]);

    await Promise.all([txA.wait(), txB.wait()]);
}

// Main Deployment Function
export async function deployFullEnvironment(): Promise<string[]> {
    try {
        console.log(`Starting full environment deployment`);

        const chainADeploymentPromise = initializeChainDeployments(
            chainAId,
            deployerA,
            fundAmount,
            wrapAmount,
        );

        const chainBDeploymentPromise = initializeChainDeployments(
            chainBId,
            deployerB,
            fundAmount,
            wrapAmount,
        );
        const [deploymentA, deploymentB] = await Promise.all([chainADeploymentPromise, chainBDeploymentPromise]);

        await wait(1500);

        await connectInterfaces(deploymentA, deploymentB);
        await wait(1500);
        const initialBalance = 100n;
        const vaultAAddressPromise = deployBasicVault(deployerA, deploymentA, initialBalance);
        const vaultBAddressPromise = deployBasicVault(deployerB, deploymentB, initialBalance);

        const [vaultAAddress, vaultBAddress] = await Promise.all([vaultAAddressPromise, vaultBAddressPromise]);
        await wait(1500);

        // Connect vaults
        const vaultA = CatalystVaultVolatile__factory.connect(vaultAAddress, deployerA);
        const vaultB = CatalystVaultVolatile__factory.connect(vaultBAddress, deployerB);
        await connectVaults(vaultA, deploymentA.chainIdBytes, vaultB, deploymentB.chainIdBytes);

        await wait(1500);

        console.log(`Full environment deployment completed successfully`);
        return [deploymentA.escrowAddress, vaultAAddress];
    } catch (error) {
        console.error("Error during full environment deployment:", error);
        throw error;
    }
}
