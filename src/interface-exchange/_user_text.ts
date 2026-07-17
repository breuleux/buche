import type { Buche } from "../core.ts";
import type { Entry } from "../entry.ts";

export interface UserTextMessage {
    type: "user_text";

    /** Raw input text from an embedded terminal (keystrokes, escapes, paste). */
    text: string;

    entry: Entry;
}

export function handle$user_text(buche: Buche, obj: UserTextMessage): void {
    buche.sendDriver({
        type: "text",
        stream: "stdin",
        text: obj.text,
        from: ["$term"],
        to: obj.entry.echo.address,
    });
}
