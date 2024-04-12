import {
    OnGatewayConnection,
    OnGatewayDisconnect,
    SubscribeMessage,
    WebSocketGateway,
    WsResponse,
} from "@nestjs/websockets";
import { Observable, Subject } from 'rxjs';
import { LoggerService } from "src/logger/logger.service";
import { MonitorService } from "./monitor.service";
import { MonitorInterface, MonitorStatus } from "./monitor.interface";
import { ConfigService } from "src/config/config.service";
import { OnModuleInit } from "@nestjs/common";

export const MONITOR_EVENT_NAME = 'monitor';

export interface MonitorEvent extends MonitorStatus {
    chainId: string;
}

@WebSocketGateway()
export class MonitorGateway implements OnModuleInit, OnGatewayConnection, OnGatewayDisconnect {

    private onMonitorObservable = new Subject<WsResponse<MonitorEvent>>();

    constructor(
        private readonly configService: ConfigService,
        private readonly monitorService: MonitorService,
        private readonly loggerService: LoggerService
    ) {}

    async onModuleInit() {
        this.loggerService.info("Monitor gateway initialized.");
        await this.listenToMonitors();
    }

    handleConnection(_client: any, ..._args: any[]) {
        this.loggerService.info('Monitor gateway: client connected.');
    }

    handleDisconnect(_client: any) {
        this.loggerService.info('Monitor gateway: client disconnected.');
    }

    @SubscribeMessage(MONITOR_EVENT_NAME)
    subscribeToMonitors(): Observable<WsResponse<MonitorEvent>> {
        this.loggerService.info("Client subscribed to new Monitor messages.")
        return this.onMonitorObservable;
    }

    private async listenToMonitors(): Promise<void> {
        this.loggerService.info(`Listening to Monitor services to broadcast state events.`);

        for (const [chainId] of this.configService.chainsConfig) {
            const monitorPort = await this.monitorService.attachToMonitor(chainId);
            const monitor = new MonitorInterface(monitorPort);

            monitor.addListener((status: MonitorStatus) => {
                this.onMonitorObservable.next({
                    event: MONITOR_EVENT_NAME,
                    data: {
                        chainId,
                        ...status
                    },
                });
            });
        }
    }

}