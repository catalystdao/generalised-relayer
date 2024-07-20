import { keccak256 } from "ethers6";


export interface LayerZeroPacket {
    nonce: number;
    srcEid: number;
    sender: string;
    dstEid: number;
    receiver: string;
    guid: string;
    message: string;
}

export interface LayerZeroHeader {
    version: number;
    nonce: number;
    srcEid: number;
    sender: string;
    dstEid: number;
    receiver: string;
}



export function decodePacket(encodedPacket: string): LayerZeroPacket {
    return {
        nonce: Number('0x' + encodedPacket.slice(2 + 2, 2 + 2 + 16)),
        srcEid: Number('0x' + encodedPacket.slice(2 + 18, 2 + 18 + 8)),
        // NOTE: keep only the last 20 bytes of the 'sender' field.
        sender: ('0x' + encodedPacket.slice(2 + 26 + 24, 2 + 26 + 64)).toLowerCase(),
        dstEid: Number('0x' + encodedPacket.slice(2 + 90, 2 + 90 + 8)),
        // NOTE: keep only the last 20 bytes of the 'receiver' field.
        receiver: ('0x' + encodedPacket.slice(2 + 98 + 24, 2 + 98 + 64)).toLowerCase(),
        guid: '0x' + encodedPacket.slice(2 + 162, 2 + 162 + 64),
        message: '0x' + encodedPacket.slice(2 + 226),
    };
}

export function decodeHeader(encodedHeader: string): LayerZeroHeader {
    return {
        version: Number('0x' + encodedHeader.slice(2, 2 + 2)),
        nonce: Number('0x' + encodedHeader.slice(2 + 2, 2 + 2 + 16)),
        srcEid: Number('0x' + encodedHeader.slice(2 + 18, 2 + 18 + 8)),
        // NOTE: keep only the last 20 bytes of the 'sender' field.
        sender: '0x' + encodedHeader.slice(2 + 26 + 24, 2 + 26 + 64).toLowerCase(),
        dstEid: Number('0x' + encodedHeader.slice(2 + 90, 2 + 90 + 8)),
        // NOTE: keep only the last 20 bytes of the 'receiver' field.
        receiver: '0x' + encodedHeader.slice(2 + 98 + 24, 2 + 98 + 64).toLowerCase(),
    }
}


export function calculatePayloadHash(guid: string, message: string): string {
    const payload = `${guid}${message.slice(2)}`;   // 'slice(2)' used to remove the '0x' from the 'message'
    return keccak256(payload);
}
