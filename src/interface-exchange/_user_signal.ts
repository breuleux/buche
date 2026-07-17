import type { Buche } from "../core.ts";
import type { Entry } from "../entry.ts";

export interface UserSignalMessage {
    type: "user_signal";

    /** The signal code to send (e.g. 15 for SIGTERM, 9 for SIGKILL). */
    code: number;

    entry: Entry;
}

export function handle$user_signal(buche: Buche, obj: UserSignalMessage): void {
    // A cell representing a process (e.g. its `$main` cell) signals the
    // process, not itself; the unresponsive marking lands on the process too,
    // so every view of it (and of the cell, which mirrors it) shows it.
    const target = obj.entry.representative() ?? obj.entry;
    buche.sendDriver({
        type: "signal",
        code: obj.code,
        from: ["$term"],
        to: target.echo.address,
    });
    // We expect a response from the shell; hold the echo until it closes.
    target.echo.status = { status: "unresponsive" };
    buche.sendInterface({
        type: "update_entry",
        entry: target,
    });
}
