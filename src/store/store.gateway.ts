import { OnGatewayInit, SubscribeMessage, WebSocketGateway, WsResponse } from "@nestjs/websockets";
import { Observable, Subject } from 'rxjs';
import { LoggerService } from "src/logger/logger.service";
import { AmbMessage } from "./types/store.types";
import { Store } from "./store.lib";

const newAMBMessageEventName = 'ambMessage';

@WebSocketGateway()
export class StoreGateway implements OnGatewayInit {

    constructor(private readonly loggerService: LoggerService) { }

    private store = new Store();
    private onAMBMessageObservable = new Subject<WsResponse<AmbMessage>>();

    async afterInit() {
        this.loggerService.info("Store gateway initialized.");
        await this.listenForNewAMBMessages();
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