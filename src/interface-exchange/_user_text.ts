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
    if (obj.entry.placeholder) {
        buche.claim([...obj.entry.parent!.address(), "$stdout"], "cell");
    }
    // Input reaches the represented entry (the process), not the cell itself.
    const target = obj.entry.representative() ?? obj.entry;
    buche.sendDriver({
        type: "text",
        stream: "stdin",
        text: obj.text,
        from: ["$term"],
        to: target.echo.address,
    });
}
