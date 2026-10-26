import type { Buche } from "../core.ts";
import type { BaseMessage } from "./common.ts";

// UNUSED: no driver sends `sync` for now (kept for planned use).
export interface SyncMessage extends BaseMessage {
    type: "sync";

    nonce: string;
}

export function handle$sync(buche: Buche, obj: SyncMessage): void {
    buche.sendDriver({
        type: "sync",
        from: ["$term"],
        to: obj.from,
        nonce: obj.nonce,
    });
}
