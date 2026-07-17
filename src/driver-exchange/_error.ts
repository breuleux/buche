import type { Buche } from "../core.ts";
import type { BaseMessage } from "./common.ts";

/** An error reported by the process */
export interface ErrorMessage extends BaseMessage {
    type: "error";

    /** Class/kind of the error, e.g. the exception type. */
    error_type: string;

    /** Human-readable error message. */
    message: string;

    /** Traceback lines, when available. */
    traceback?: string[];
}

export function handle$error(buche: Buche, obj: ErrorMessage): void {
    console.error("[buche] process reported an error:", obj, obj.traceback);
    const entry = buche.hierarchy.getAt(obj.from, false);

    buche.sendInterface({
        type: "problem",
        code: "process",
        reason: obj.message,
        input: obj,
        entry: entry ?? undefined,
    });
}
