import { MessagePort } from "worker_threads";



// Port Channels Types
// ************************************************************************************************
export interface PricingGetPortMessage {
    messageId: number;
}

export interface PricingGetPortResponse {
    messageId: number;
    port: MessagePort;
}


export interface GetPriceMessage {
    messageId: number;
    chainId: string;
    amount: bigint;
}

export interface GetPriceResponse {
    messageId: number;
    chainId: string;
    amount: bigint;
    price: number | null;
}