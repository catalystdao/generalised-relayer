import { MessagePort } from "worker_threads";



// Port Channels Types
// ************************************************************************************************
export interface MonitorGetPortMessage {
    messageId: number;
}

export interface MonitorGetPortResponse {
    messageId: number;
    port: MessagePort;
}

export interface MonitorStatusMessage {
    // ! The 'blockNumber' is prefixed as 'observed' to highlight that this is the block number
    // ! as returned by the rpc. Some chains use different block numbers within rpc queries and
    // ! transactions (e.g. Arbitrum uses l2 and l1 block numbers).
    observedBlockNumber: number;
    blockHash: string | null;
    timestamp: number;
}
