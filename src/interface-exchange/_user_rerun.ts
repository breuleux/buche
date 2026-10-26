import type { Buche } from "../core.ts";
import type { Entry } from "../entry.ts";

export interface UserRerunMessage {
    type: "user_rerun";

    entry: Entry;
}

/**
 * The user asks for an entry's process to be run again: the request goes to
 * its address, for its driver to decide what to run (see RerunRequest). What
 * the cells show changes when the driver says so (its `reset`), not before:
 * a driver may well ignore it.
 */
export function handle$user_rerun(buche: Buche, obj: UserRerunMessage): void {
    buche.sendDriver({
        type: "rerun",
        from: ["$term"],
        to: obj.entry.address(),
    });
}
