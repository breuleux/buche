import type { Buche } from "../core.ts";
import type { Echo } from "../echo.ts";
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

function killable(echo: Echo) {
    return echo.status.status === "running" || echo.status.status === "unresponsive";
}

export function handle$close(buche: Buche, obj: CloseMessage): void {
    const status = obj.outcome.type === "success" ? "done" : "error";
    const h = buche.hierarchy.getAt(obj.from);
    for (const component of h ? h.walk() : []) {
        const echo = component.echo;
        if (killable(echo)) {
            echo.status = { status, code: obj.outcome.code };
            buche.sendInterface({
                type: "update_component",
                component: component,
            });
        }
    }
}
