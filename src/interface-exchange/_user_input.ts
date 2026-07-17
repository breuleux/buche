import type { Buche } from "../core.ts";
import type { Entry } from "../entry.ts";

export interface UserInputMessage {
    type: "user_input";

    entry: Entry;

    text: string;
    position: number;
}

export function handle$user_input(buche: Buche, obj: UserInputMessage): void {
    buche.sendDriver({
        type: "parse",
        from: ["$term"],
        to: obj.entry.echo.address,
        text: obj.text,
        position: obj.position,
    });
}
