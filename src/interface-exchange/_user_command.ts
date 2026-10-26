import type { Buche } from "../core.ts";
import type { Entry } from "../entry.ts";
import type { Selection } from "../types.ts";

export interface UserCommandMessage {
    type: "user_command";

    entry: Entry;

    text: string;
    selection: Selection;
    command: string;

    /** Identifies the command; forwarded to the driver (see CommandRequest). */
    id?: string;

    /** Where what it shows goes; forwarded to the driver (see CommandRequest). */
    zone?: string;
}

export function handle$user_command(buche: Buche, obj: UserCommandMessage): void {
    buche.sendDriver({
        type: "command",
        from: ["$term"],
        to: obj.entry.echo.address,
        text: obj.text,
        selection: obj.selection,
        command: obj.command,
        ...(obj.id !== undefined ? { id: obj.id } : {}),
        ...(obj.zone !== undefined ? { zone: obj.zone } : {}),
    });
}
