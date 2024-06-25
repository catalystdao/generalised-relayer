import pino from "pino";
import { BasePricingProvider, PricingProviderConfig, loadPricingProvider } from "./pricing.provider";
import { PricingWorkerData } from "./pricing.service";
import { parentPort, workerData, MessagePort, MessageChannel } from "worker_threads";
import { GetPriceResponse, PricingGetPortMessage, PricingGetPortResponse, GetPriceMessage } from "./pricing.types";


class PricingWorker {
    private readonly config: PricingWorkerData;

    private readonly providers = new Map<string, BasePricingProvider>();

    private readonly logger: pino.Logger;


    private portsCount = 0;
    private readonly ports: Record<number, MessagePort> = {};

    constructor() {
        this.config = workerData as PricingWorkerData;
        this.logger = this.initializeLogger();

        this.initializeProviders();

        this.initializePorts();
    }



    // Initialization helpers
    // ********************************************************************************************

    private initializeLogger(): pino.Logger {
        return pino(this.config.loggerOptions).child({
            worker: 'pricing'
        });
    }

    private initializeProviders() {
        for (const [chainId, config] of Object.entries(this.config.chainPricingProviderConfigs)) {
            this.initializeProvider(chainId, config);
        }
    }

    private initializeProvider(chainId: string, config: PricingProviderConfig) {
        const logger = this.logger.child({ chainId });
        const provider = loadPricingProvider(config, logger);
        this.providers.set(chainId, provider);
    }

    private initializePorts(): void {
        parentPort!.on('message', (message: PricingGetPortMessage) => {
            const port = this.registerNewPort();
            const response: PricingGetPortResponse = {
                messageId: message.messageId,
                port
            };
            parentPort!.postMessage(response, [port]);
        });
    }

    private registerNewPort(): MessagePort {

        const portId = this.portsCount++;

        const { port1, port2 } = new MessageChannel();

        port1.on('message', (request: GetPriceMessage) => {
            const pricePromise = this.getPrice(request.chainId, request.amount);
            void pricePromise.then((price) => {
                const response: GetPriceResponse = {
                    messageId: request.messageId,
                    chainId: request.chainId,
                    amount: request.amount,
                    price
                };
                port1.postMessage(response);
            });
        })

        this.ports[portId] = port1;

        return port2;
    }

    private async getPrice(chainId: string, amount: bigint): Promise<number | null> {
        const provider = this.providers.get(chainId);
        if (provider == undefined) {
            return null;
        }

        return provider.getPrice(amount);
    }
    
}

new PricingWorker();
