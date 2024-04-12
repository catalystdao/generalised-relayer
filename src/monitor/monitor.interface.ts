import { MessagePort } from 'worker_threads';

export interface MonitorStatus {
    blockNumber: number;
    hash: string | null;
    timestamp: number;
}

export class MonitorInterface {

    constructor(private readonly port: MessagePort) {}

    close() {
        this.port.close();
    }

    addListener(listener: (status: MonitorStatus) => void) {
        this.port.on('message', listener);
    }

    removeListener(listener: (status: MonitorStatus) => void) {
        this.port.off('message', listener);
    }
}