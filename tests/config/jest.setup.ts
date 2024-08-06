import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import crossSpawn from 'cross-spawn';
import { deployFullEnvironment } from './deployment/deployment';
import { fundWallets } from './deployment/fund-wallets';
import { generateConfig } from './config';


async function startAnvil(port: string, chainId: string, pids: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
        const anvil = spawn('anvil', ['--port', port, '--chain-id', chainId], { stdio: 'inherit' });

        if (anvil.pid) {
            pids.push(anvil.pid.toString());
        }

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
    const pids: string[] = [];

    try {
        await startAnvil('8545', '1', pids);
        await startAnvil('8546', '2', pids);

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
            const relayer = crossSpawn('sh', ['-c', 'NODE_ENV=test CONFIG_FILE_PATH=./tests/config/config.test.yaml nest start'], {
                stdio: 'inherit'
            });

            if (relayer.pid) {
                pids.push(relayer.pid.toString());
            }
            // Give some time to ensure the relayer has started properly
            setTimeout(() => {
                resolve();
            }, 30000);
        });

        await fs.writeFile('./tests/config/pids.json', JSON.stringify(pids, null, 2));

    } catch (error) {
        console.error('Global setup failed:', error);
        throw error;
    }
}
