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

    /** Whether the status change propagates to subaddresses. */
    propagate?: boolean;
}

export function handle$close(buche: Buche, obj: CloseMessage): void {
    const status = obj.outcome.type === "success" ? "done" : "error";
    const h = buche.hierarchy.getAt(obj.from);
    const entries = h ? (obj.propagate === false ? [h] : h.walk()) : [];
    for (const entry of entries) {
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
