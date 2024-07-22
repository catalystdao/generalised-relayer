import { OnGatewayInit, SubscribeMessage, WebSocketGateway, WsResponse } from "@nestjs/websockets";
import { Observable, Subject } from 'rxjs';
import { LoggerService } from "src/logger/logger.service";
import { AMBMessage } from "./store.types";
import { Store } from "./store.lib";

const newAMBMessageEventName = 'ambMessage';

@WebSocketGateway()
export class StoreGateway implements OnGatewayInit {

    constructor(private readonly loggerService: LoggerService) {}

    private store = new Store();
    private onAMBMessageObservable = new Subject<WsResponse<AMBMessage>>();

    async afterInit() {
        this.loggerService.info("Store gateway initialized.");
        await this.listenForNewAMBMessages();
    }

    @SubscribeMessage(newAMBMessageEventName)
    subscribeToAMBMessages(): Observable<WsResponse<AMBMessage>> {
        this.loggerService.info("Client subscribed to new AMB messages.")
        return this.onAMBMessageObservable;
    }

    private async listenForNewAMBMessages(): Promise<void> {
        this.loggerService.info(`Listening for new AMB messages to broadcast.`);

        const onAMBMessageChannelPattern = Store.getOnAMBMessageChannel('*');

        await this.store.onPattern(onAMBMessageChannelPattern, (event: any) => {

            const message = event as AMBMessage;
            this.onAMBMessageObservable.next({
                event: newAMBMessageEventName,
                data: message
            })
        });
    }

}