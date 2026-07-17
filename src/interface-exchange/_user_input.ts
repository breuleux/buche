import type { Buche } from "../core.ts";
import type { Entry } from "../entry.ts";

export interface UserInputMessage {
    type: "user_input";

    entry: Entry;

    text: string;
    position: number;
}

export function handle$user_input(buche: Buche, obj: UserInputMessage): void {
    // Stamp the parse with a reference number: the highlight echo answering
    // it (a prompt_configure carrying the same request_id) is only applied
    // while it is still the latest parse for this prompt.
    const requestId = `r${++buche.requestSeq}`;
    if (obj.entry.prompt) {
        obj.entry.prompt.request_id = requestId;
    }
    buche.sendDriver({
        type: "parse",
        from: ["$term"],
        to: obj.entry.echo.address,
        request_id: requestId,
        text: obj.text,
        position: obj.position,
    });
}
