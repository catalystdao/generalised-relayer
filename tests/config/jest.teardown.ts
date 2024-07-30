import { exec } from 'child_process';
import util from 'util';

const execPromise = util.promisify(exec);

export default async function globalTeardown() {
    if (process.env['JEST_WATCH_MODE']) {
        console.log('In watch mode, skipping global teardown...');
        return;
    }

    console.log('Running global teardown...');

    try {
        await execPromise('pkill pnpm');
        console.log('Relayer process stopped.');
    } catch (error) {
        console.error('Failed to stop relayer process:', error);
    }

    try {
        await execPromise('pkill anvil');
        console.log('Anvil processes stopped.');
    } catch (error) {
        console.error('Failed to stop Anvil processes:', error);
    }
}