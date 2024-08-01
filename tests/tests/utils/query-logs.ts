import { JsonRpcProvider, Log } from "ethers6";
import { config } from "../../config/config";
import { wait } from "@App/common/utils";

const retryInterval = config.global.getter.retryInterval;

export async function queryLogs(address: string, topic: string, provider: JsonRpcProvider, blockHash: string): Promise<Log | undefined> {
    if (retryInterval === undefined) {
        throw new Error('Retry interval is not defined');
    }


    const filter = {
        address,
        topics: [topic],
        blockHash: blockHash,
    };

    let logs: Log[] | undefined;
    while (logs === undefined || logs.length === 0) {
        try {
            logs = await provider.getLogs(filter);
        } catch (error) {
            await wait(retryInterval);
        }
    }

    return logs.length > 0 ? logs[0] : undefined;
}
