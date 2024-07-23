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
    tokenId?: string;
}

export interface GetPriceResponse {
    messageId: number;
    chainId: string;
    amount: bigint;
    price: number | null;
    tokenId?: string;
}



// Controller Types
// ************************************************************************************************

export interface GetPriceQuery {
    chainId: string;
    tokenId?: string;
    amount: string;
}

export interface GetPriceQueryResponse {
    chainId: string;
    tokenId?: string;
    amount: string;
    price: number | null;
}