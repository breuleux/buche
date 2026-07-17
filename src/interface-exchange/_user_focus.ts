import type { Buche } from "../core.ts";

export interface UserFocusMessage {
    type: "user_focus";
}

export function handle$user_focus(buche: Buche, obj: UserFocusMessage): void {
    // TODO
}
