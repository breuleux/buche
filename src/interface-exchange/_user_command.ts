import type { Buche } from "../core.ts";
import type { Entry } from "../entry.ts";

export interface UserCommandMessage {
    type: "user_command";

    entry: Entry;

    text: string;
    position: number;
    command: string;

    /** Identifies the command; forwarded to the driver (see CommandRequest). */
    id?: string;
}

export function handle$user_command(buche: Buche, obj: UserCommandMessage): void {
    buche.sendDriver({
        type: "command",
        from: ["$term"],
        to: obj.entry.echo.address,
        text: obj.text,
        position: obj.position,
        command: obj.command,
        ...(obj.id !== undefined ? { id: obj.id } : {}),
    });
}
