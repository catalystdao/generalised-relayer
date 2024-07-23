import { GasEstimateComponents } from "src/resolvers/resolver";
import { MessagePort } from "worker_threads";
import { EvaluateAckMessage, EvaluateAckResponseMessage, EvaluateDeliveryMessage, EvaluateDeliveryResponseMessage, EvaluatorMessage, EvaluatorMessageType, EvaluatorPortData } from "./evaluator.types";


export class EvaluatorInterface {
    private portMessageId = 0;

    constructor(private readonly port: MessagePort) {}

    private getNextPortMessageId(): number {
        return this.portMessageId++;
    }

    private async submitMessage(message: EvaluatorMessage): Promise<any> {

        const messageId = this.getNextPortMessageId();

        const data: EvaluatorPortData = {
            messageId,
            message
        };
        
        const resultPromise = new Promise<any>(resolve => {
            const listener = (responseData: EvaluatorPortData) => {
                if (responseData.messageId === messageId) {
                    this.port.off("message", listener);
                    resolve(responseData.message)
                }
            }
            this.port.on("message", listener);

            this.port.postMessage(data);
        });

        return resultPromise;
    }

    async evaluateDelivery(
        chainId: string,
        messageIdentifier: string,
        gasEstimateComponents: GasEstimateComponents,
        value: bigint,
    ): Promise<EvaluateDeliveryResponseMessage> {

        const message: EvaluateDeliveryMessage = {
            type: EvaluatorMessageType.EvaluateDelivery,
            chainId,
            messageIdentifier,
            gasEstimateComponents,
            value
        };

        return this.submitMessage(message);
    }

    async evaluateAck(
        chainId: string,
        messageIdentifier: string,
        gasEstimateComponents: GasEstimateComponents,
        value: bigint,
    ): Promise<EvaluateAckResponseMessage> {

        const message: EvaluateAckMessage = {
            type: EvaluatorMessageType.EvaluateAck,
            chainId,
            messageIdentifier,
            gasEstimateComponents,
            value
        };

        return this.submitMessage(message);
    }
}
