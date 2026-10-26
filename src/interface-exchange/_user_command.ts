import type { Buche } from "../core.ts";
import type { Entry } from "../entry.ts";
import type { Action, Address, Selection } from "../types.ts";

export interface UserCommandMessage {
    type: "user_command";

    entry: Entry;

    text: string;
    selection: Selection;
    action: Action;

    /** Identifies the command; forwarded to the driver (see CommandRequest). */
    id?: string;

    /** Where what it shows goes; forwarded to the driver (see CommandRequest). */
    zone?: string;

    /** Where it was performed, if not in the prompt; forwarded to the driver
     *  (see CommandRequest). */
    anchor?: Address;
}

export function handle$user_command(buche: Buche, obj: UserCommandMessage): void {
    buche.sendDriver({
        type: "command",
        from: ["$term"],
        to: obj.entry.address(),
        text: obj.text,
        selection: obj.selection,
        action: obj.action,
        ...(obj.id !== undefined ? { id: obj.id } : {}),
        ...(obj.zone !== undefined ? { zone: obj.zone } : {}),
        ...(obj.anchor !== undefined ? { anchor: obj.anchor } : {}),
    });
}
