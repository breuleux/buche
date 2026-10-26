import type { Buche } from "../core.ts";
import { bubblesTo, type Entry } from "../entry.ts";

export interface UserSignalMessage {
    type: "user_signal";

    /** The signal code to send (e.g. 15 for SIGTERM, 9 for SIGKILL). */
    code: number;

    entry: Entry;
}

/**
 * The user signals an entry (its ✕): the signal goes to its address, and the
 * entry is marked unresponsive until its driver ends it. It then bubbles up
 * (see bubblesTo): closing a process's last view signals the process. Each
 * driver acts on the addresses it owns (signals to a process's views mean
 * nothing to coquille, say: the process's own does).
 */
export function handle$user_signal(buche: Buche, obj: UserSignalMessage): void {
    for (let entry: Entry | null = obj.entry; entry; entry = bubblesTo(entry)) {
        buche.sendDriver({
            type: "signal",
            code: obj.code,
            from: ["$term"],
            to: entry.address(),
        });
        entry.cell.status = { status: "unresponsive" };
        buche.sendInterface({ type: "update_entry", entry });
    }
}
