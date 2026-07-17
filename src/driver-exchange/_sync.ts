import type { Buche, OutM } from "../core.ts";
import type { BaseMessage } from "./common.ts";

export interface SyncMessage extends BaseMessage {
    type: "sync";

    nonce: string;
}

export async function* handle$sync(buche: Buche, obj: SyncMessage): AsyncIterable<OutM> {
    yield {
        type: "sync",
        from: ["$term"],
        to: obj.from,
        nonce: obj.nonce,
    };
}
