import { exec } from 'child_process';
import util from 'util';
import { promises as fs } from 'fs';

const execPromise = util.promisify(exec);

export default async function globalTeardown() {
    if (process.env['JEST_WATCH_MODE']) {
        console.log('In watch mode, skipping global teardown...');
        return;
    }

    console.log('Running global teardown...');

    try {
        const pidsData = await fs.readFile('pids.json', 'utf-8');
        const pids: string[] = JSON.parse(pidsData);

        for (const pid of pids) {
            try {
                await execPromise(`kill ${pid}`);
                console.log(`Process with PID ${pid} stopped.`);
            } catch (error) {
                console.error(`Failed to stop process with PID ${pid}:`, error);
            }
        }

        // Delete the pids.json file after teardown
        await fs.unlink('pids.json');
    } catch (error) {
        console.error('Failed to process teardown:', error);
    }
}
