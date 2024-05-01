import { MessagePort } from 'worker_threads';
import { GetPriceMessage, GetPriceResponse } from './pricing.types';

export class PricingInterface {
    private portMessageId = 0;

    constructor(private readonly port: MessagePort) {}

    private getNextPortMessageId(): number {
        return this.portMessageId++;
    }

    async getPrice(
        chainId: string,
        amount: bigint,
    ): Promise<number | null> {

        const messageId = this.getNextPortMessageId();

        const resultPromise = new Promise<number | null>(resolve => {
            const listener = (data: GetPriceResponse) => {
                if (data.messageId === messageId) {
                    this.port.off("message", listener);
                    resolve(data.price);
                }
            };
            this.port.on("message", listener);

            const request: GetPriceMessage = {
                messageId,
                chainId,
                amount
            };
            this.port.postMessage(request);
        });

        return resultPromise;
    }
}
