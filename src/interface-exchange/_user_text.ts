import type { Buche } from "../core.ts";
import type { Entry } from "../entry.ts";

export interface UserTextMessage {
    type: "user_text";

    /** Raw input text from an embedded terminal (keystrokes, escapes, paste). */
    text: string;

    entry: Entry;
}

export function handle$user_text(buche: Buche, obj: UserTextMessage): void {
    // Typing into a placeholder makes it the process's terminal.
    if (obj.entry.cell?.kind === "pending") {
        buche.claim([...obj.entry.parent!.address(), "$stdout"], "terminal");
    }
    // Input goes to the cell's own address: its driver knows what it is for
    // (a process's `$stdout` is its terminal).
    buche.sendDriver({
        type: "text",
        stream: "stdin",
        text: obj.text,
        from: ["$term"],
        to: obj.entry.address(),
    });
}
