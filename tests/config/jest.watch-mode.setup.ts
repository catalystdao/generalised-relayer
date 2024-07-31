/* This script is for development purposes and is used to emulate a watch mode using blockchain and the relayer.
    Since many parts are involved on the deployment and the tests, it is difficult to run the tests in watch mode
    so, we recommend to follow the steps below to run it:

    1. Run anvil using the commands on different terminals:
        - anvil --port 8545 --chain-id 1
        - anvil --port 8546 --chain-id 2

    2. Comment the second part, leaving the first part uncommented and execute pnpm test:watch command.

    3. Open other terminal and run the relayer using the following command:
        - CONFIG_FILE_PATH=./tests/config/config.test.yaml nest start

    4. Comment the first part leaving the second part uncommented 

    5. You can now execute the tests in watch mode and debug the tests.
*/

import { fundWallets } from './deployment/fund-wallets';
import dotenv from 'dotenv';
import crossSpawn from 'cross-spawn';
import { deployFullEnvironment } from './deployment/deployment';
import { generateConfig } from './config';


export default async function globalSetup() {
    console.log('Running global setup...');

    try {
        try {
            // FIRST PART

            // const [escrowAddress, vaultAAddress] = await new Promise<string[]>((resolve, reject) => {
            //     deployFullEnvironment()
            //         .then(result => {
            //             console.log("Result of deployment:", result);
            //             resolve(result);
            //         })
            //         .catch(error => {
            //             console.error("Error during deployment:", error);
            //             reject(error);
            //         });
            // });

            // if (escrowAddress && vaultAAddress) {
            //     generateConfig(escrowAddress, vaultAAddress);
            //     await fundWallets();
            // } else {
            //     throw new Error('Deployment failed');
            // }


            // SECOND PART

            await fundWallets();
            dotenv.config();

        } catch (error) {
            console.error('Failed to set up deployment', error);
            throw error;
        }

    } catch (error) {
        console.error('Global setup failed:', error);
        throw error;
    }
}

