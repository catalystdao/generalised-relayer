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
    blockNumber: number;
    blockHash: string | null;
    timestamp: number;
}
