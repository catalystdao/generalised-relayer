import { Wallet, parseEther, JsonRpcProvider } from 'ethers6';
import { ATTEMPTS_MAXIMUM, TIME_BETWEEN_ATTEMPTS, loadConfig } from '../../config/config';
import { Transaction, performSwap } from '../utils/perform-swap';
import { IMessageEscrowEvents__factory } from '../../contracts/factories/IMessageEscrowEvents__factory';
import { Store } from '@App/store/store.lib';
import { queryLogs } from '../utils/query-logs';
import { BountyPlacedEvent } from '@App/contracts/IMessageEscrowEvents';
import { wait } from '@App/common/utils';
import { RelayState } from '@App/store/store.types';


jest.setTimeout(30000000);

let relayState: Partial<RelayState> | null;
let attemptsCounter = 0;
let store: Store;

let config = loadConfig('./tests/config/config.test.yaml');

beforeAll(async () => {
    store = new Store();
});

beforeEach(async () => {
    relayState = null;
    attemptsCounter = 0;
});

afterAll(async () => {
    store.quit();
});


describe('BountyPlaced Events Tests', () => {

    const incentivesEscrowInterface = IMessageEscrowEvents__factory.createInterface();
    const incentiveAddress = config.chains[0]?.mock?.incentivesAddress;
    const privateKey = config.ambs[0]?.privateKey;
    if (!incentiveAddress || !privateKey) {
        throw new Error('Incentive address not found');
    }
    const provider = new JsonRpcProvider(config.chains[0]?.rpc, undefined, { staticNetwork: true });

    const validTransactOpts: Transaction = {
        direction: true,
        swapAmount: parseEther('0.1').toString(),
        incentivePayment: parseEther('0.5').toString(),
        incentive: {
            maxGasDelivery: 2000000,
            maxGasAck: 2000000,
            refundGasTo: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
            priceOfDeliveryGas: "50000000000",
            priceOfAckGas: "50000000000",
            targetDelta: 0
        }
    };

    it('should retrieve expected Bounty Placed Event transaction successfully', async () => {

        const wallet = new Wallet(privateKey, new JsonRpcProvider(config.chains[0]?.rpc));

        const tx = await performSwap(wallet, validTransactOpts)

        const receipt = await tx.wait(1);
        const blockHash = receipt?.blockHash;
        if (!blockHash) {
            throw new Error("Block number not found");
        }
        const log = await queryLogs(incentiveAddress, incentivesEscrowInterface.getEvent('BountyPlaced').topicHash, provider, blockHash);

        if (log) {
            const parsedLog = incentivesEscrowInterface.parseLog(log);
            const event = parsedLog?.args as unknown as BountyPlacedEvent.OutputObject;
            const messageIdentifier = event.messageIdentifier;
            while (attemptsCounter < ATTEMPTS_MAXIMUM && !relayState) {
                relayState = await store.getRelayStateByKey('relay_state:' + messageIdentifier);

                attemptsCounter += 1;
                if (relayState === null) {
                    await wait(TIME_BETWEEN_ATTEMPTS);
                }
            }

            if (!relayState) {
                throw new Error("Exceeded maximum attempts or bounty not found");
            }

            const expectedStructure: Partial<RelayState> = {
                status: expect.any(Number),
                messageIdentifier: expect.any(String),
                bountyPlacedEvent: {
                    transactionHash: expect.any(String),
                    blockHash: expect.any(String),
                    blockNumber: expect.any(Number),
                    fromChainId: expect.any(String),
                    incentivesAddress: expect.any(String),
                    maxGasDelivery: expect.any(BigInt),
                    maxGasAck: expect.any(BigInt),
                    refundGasTo: expect.any(String),
                    priceOfDeliveryGas: expect.any(BigInt),
                    priceOfAckGas: expect.any(BigInt),
                    targetDelta: expect.any(BigInt),
                },
            };

            expect(relayState).toMatchObject(expectedStructure);
        } else {
            throw new Error("Log not found");
        }

    });


});