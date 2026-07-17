import { type Buche } from "../core.ts";
import { BaseMessage } from "./common.ts";

export interface SyncMessage extends BaseMessage {
  type: "sync";

  nonce: string;
}

export async function handle$sync(
    buche: Buche,
    obj: SyncMessage
): Promise<void> {
    // TODO
}
