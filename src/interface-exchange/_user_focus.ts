import type { Buche } from "../core.ts";

// UNUSED: the interface never emits `user_focus` for now (kept for planned
// use).
export interface UserFocusMessage {
    type: "user_focus";
}

export function handle$user_focus(buche: Buche, obj: UserFocusMessage): void {
    // TODO
}
