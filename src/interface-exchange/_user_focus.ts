import type { Buche, OutM } from "../core.ts";

export interface UserFocusMessage {
    type: "user_focus";
}

export async function* handle$user_focus(
    buche: Buche,
    obj: UserFocusMessage,
): AsyncIterable<OutM> {
    // TODO
}
