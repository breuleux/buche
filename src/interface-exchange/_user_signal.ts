import type { Buche } from "../core.ts";
import type { Entry } from "../entry.ts";

export interface UserSignalMessage {
    type: "user_signal";

    /** The signal code to send (e.g. 15 for SIGTERM, 9 for SIGKILL). */
    code: number;

    entry: Entry;
}

export function handle$user_signal(buche: Buche, obj: UserSignalMessage): void {
    buche.sendDriver({
        type: "signal",
        code: obj.code,
        from: ["$term"],
        to: obj.entry.echo.address,
    });
    // We expect a response from the shell; hold the echo until it closes.
    obj.entry.echo.status = { status: "unresponsive" };
    buche.sendInterface({
        type: "update_entry",
        entry: obj.entry,
    });
}
