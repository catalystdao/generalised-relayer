import { Block, JsonRpcProvider } from "ethers6";
import pino, { LoggerOptions } from "pino";
import { workerData, parentPort, MessageChannel, MessagePort } from 'worker_threads';
import { MonitorWorkerData } from "./monitor.service";
import { MonitorGetPortMessage, MonitorGetPortResponse, MonitorStatusMessage } from "./monitor.types";
import { wait } from "src/common/utils";

class MonitorWorker {

    private readonly config: MonitorWorkerData;

    private readonly chainId: string;

    private readonly provider: JsonRpcProvider;
    private readonly logger: pino.Logger;


    private portsCount = 0;
    private readonly ports: Record<number, MessagePort> = {};

    private noBlockUpdateReferenceTimestamp = Date.now();

    private lastBroadcastBlockNumber = -1;
    private latestBlock: Block | null = null;


    constructor() {
        this.config = workerData as MonitorWorkerData;

        this.chainId = this.config.chainId;

        this.provider = this.initializeProvider(this.config.rpc);
        this.logger = this.initializeLogger(
            this.chainId,
            this.config.loggerOptions,
        );

        this.initializePorts();
    }



    // Initialization helpers
    // ********************************************************************************************

    private initializeLogger(
        chainId: string,
        loggerOptions: LoggerOptions,
    ): pino.Logger {
        return pino(loggerOptions).child({
            worker: 'monitor',
            chain: chainId,
        });
    }

    private initializeProvider(rpc: string): JsonRpcProvider {
        return new JsonRpcProvider(
            rpc,
            undefined,
            { staticNetwork: true }
        )
    }

    private initializePorts(): void {
        parentPort!.on('message', (message: MonitorGetPortMessage) => {
            const port = this.registerNewPort();
            const response: MonitorGetPortResponse = {
                messageId: message.messageId,
                port
            };
            parentPort!.postMessage(response, [port])
        });
    }

    private registerNewPort(): MessagePort {

        const portId = this.portsCount++;

        const { port1, port2 } = new MessageChannel();

        this.ports[portId] = port1;

        return port2;
    }



    // Main handler
    // ********************************************************************************************

    async run(): Promise<void> {
        this.logger.info(
            `Monitor worker started.`
        );

        while (true) {
            try {
                const newBlock = await this.provider.getBlock(-this.config.blockDelay);
                if (!newBlock || newBlock.number <= this.lastBroadcastBlockNumber) {

                    const noBlockUpdateWarningElapsedTime = Date.now()
                        - this.noBlockUpdateReferenceTimestamp;

                    if (noBlockUpdateWarningElapsedTime > this.config.noBlockUpdateWarningInterval) {
                        this.logger.warn(
                            {
                                warningInterval: this.config.noBlockUpdateWarningInterval,
                                latestBlockQuery: newBlock
                            },
                            `Failed to update block.`
                        );

                        // Avoid the logs from getting filled with warnings once 'noBlockUpdateWarningInterval' has elapsed
                        this.noBlockUpdateReferenceTimestamp = Date.now();
                    }
                    await wait(this.config.interval);
                    continue;
                }

                this.logger.debug(
                    `Monitor at block ${newBlock.number}.`,
                );

                this.latestBlock = newBlock;
                this.noBlockUpdateReferenceTimestamp = Date.now();

                this.broadcastStatus();
            }
            catch (error) {
                this.logger.error(error, `Failed on monitor.service`);
            }

            await wait(this.config.interval);
        }
    }

    private broadcastStatus(): void {
        if (!this.latestBlock) {
            this.logger.warn('Unable to broadcast status. \'latestBlock\' is null.');
            return;
        }

        const status: MonitorStatusMessage = {
            blockNumber: this.latestBlock.number,
            blockHash: this.latestBlock.hash,
            timestamp: this.latestBlock.timestamp
        };

        for (const port of Object.values(this.ports)) {
            port.postMessage(status);
        }

        this.lastBroadcastBlockNumber = status.blockNumber;
    }

}

void new MonitorWorker().run();
