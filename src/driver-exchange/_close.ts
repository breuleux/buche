import type { Buche } from "../core.ts";
import { killable } from "../echo.ts";
import type { BaseMessage } from "./common.ts";

/** Outcome of a process that has terminated. */
export interface CloseOutcome {
    /** Whether the process ended successfully or with an error. */
    type: "success" | "error";

    /** Exit/return code, when available. */
    code?: number;
}

export interface CloseMessage extends BaseMessage {
    type: "close";

    /** How the process terminated. */
    outcome: CloseOutcome;
}

export function handle$close(buche: Buche, obj: CloseMessage): void {
    const status = obj.outcome.type === "success" ? "done" : "error";
    const h = buche.hierarchy.getAt(obj.from);
    for (const entry of h ? h.walk() : []) {
        const echo = entry.echo;
        if (killable(echo)) {
            echo.status = { status, code: obj.outcome.code };
            buche.sendInterface({
                type: "update_entry",
                entry: entry,
            });
        }
    }
}
