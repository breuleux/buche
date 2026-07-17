import { type OutM, type Buche } from "../core.ts";
import { type BaseMessage } from "./common.ts";

export interface SyncMessage extends BaseMessage {
    type: "sync";

    nonce: string;
}

export async function* handle$sync(buche: Buche, obj: SyncMessage): AsyncIterable<OutM> {
    // buche.send({
    //     type: "sync",
    //     from: ["$terminal"],
    //     to: obj.from,
    //     nonce: obj.nonce,
    // })
}
