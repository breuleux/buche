import type { Buche, OutM } from "../core.ts";
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

export async function* handle$error(buche: Buche, obj: ErrorMessage): AsyncIterable<OutM> {
    const component = buche.hierarchy.getAt(obj.from, false)?.component;

    yield {
        type: "problem",
        code: "process",
        reason: obj.message,
        input: obj,
        component: component,
    };
}
