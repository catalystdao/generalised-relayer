import { spawn } from 'child_process';
import crossSpawn from 'cross-spawn';
import { deployFullEnvironment } from './deployment/deployment';
import { fundWallets } from './deployment/fund-wallets';
import { generateConfig } from './config';

async function startAnvil(port: string, chainId: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const anvil = spawn('anvil', ['--port', port, '--chain-id', chainId], { stdio: 'inherit' });

        anvil.stdout?.on('data', (data) => {
            console.log(data);
        });

        anvil.stderr?.on('data', (data) => {
            console.error(`Anvil stderr: ${data}`);
        });

        anvil.on('error', (error) => {
            console.error(`Failed to start Anvil on port ${port} with chain-id ${chainId}: ${error}`);
            reject(error);
        });

        anvil.on('close', (code) => {
            console.log(`Anvil process exited with code ${code}`);
        });

        // Give some time to ensure Anvil has started properly
        setTimeout(() => {
            resolve();
        }, 5000);
    });
}

export default async function globalSetup() {
    try {
        await startAnvil('8545', '1');
        await startAnvil('8546', '2');

        const [escrowAddress, vaultAAddress] = await new Promise<string[]>((resolve, reject) => {
            deployFullEnvironment()
                .then(result => {
                    console.log("Result of deployment:", result);
                    resolve(result);
                })
                .catch(error => {
                    console.error("Error during deployment:", error);
                    reject(error);
                });
        });

        if (escrowAddress && vaultAAddress) {
            generateConfig(escrowAddress, vaultAAddress);
            await fundWallets();
        } else {
            throw new Error('Deployment failed');
        }

        await new Promise<void>((resolve) => {
            crossSpawn('sh', ['-c', 'CONFIG_FILE_PATH=./tests/config/config.test.yaml nest start'], {
                stdio: 'inherit'
            });

            // Give some time to ensure the relayer has started properly
            setTimeout(() => {
                resolve();
            }, 30000);
        });
    } catch (error) {
        console.error('Global setup failed:', error);
        throw error;
    }
}