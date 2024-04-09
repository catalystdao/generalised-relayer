import {
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnGatewayInit,
    SubscribeMessage,
    WebSocketGateway,
    WebSocketServer,
    WsResponse,
} from "@nestjs/websockets";
import { Observable, Subject } from 'rxjs';
import { LoggerService } from "src/logger/logger.service";
import { AmbMessage } from "./types/store.types";
import { Store } from "./store.lib";

const newAMBMessageEventName = 'ambMessage';

//TODO this is currently on the main thread. Move to worker?

@WebSocketGateway()
export class StoreGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {

    constructor(private readonly loggerService: LoggerService) { }

    private store = new Store();
    private onAMBMessageObservable = new Subject<WsResponse<AmbMessage>>();

    afterInit() {
        this.loggerService.info("Store gateway initialized.");
        this.listenForNewAMBMessages();
    }

    handleConnection(client: any, ...args: any[]) {
        this.loggerService.info('Store gateway: client connected.');
    }

    handleDisconnect(client: any) {
        this.loggerService.info('Store gateway: client disconnected.');
    }

    @SubscribeMessage(newAMBMessageEventName)
    subscribeToAMBMessages(): Observable<WsResponse<AmbMessage>> {
        this.loggerService.info("Client subscribed to new AMB messages.")
        return this.onAMBMessageObservable;
    }

    private async listenForNewAMBMessages(): Promise<void> {
        this.loggerService.info(`Listening for new AMB messages to broadcast.`);

        await this.store.on(Store.newAMBChannel, (message: AmbMessage) => {
            this.onAMBMessageObservable.next({
                event: newAMBMessageEventName,
                data: message
            })
        });
    }

}