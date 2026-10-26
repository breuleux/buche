import type { Buche } from "../core.ts";

export interface UserSpawnMessage {
    type: "user_spawn";

    /** The shell to start (e.g. "cq"). */
    command: string;

    /** Where it goes (its prompt), as a zone. */
    zone?: string;
}

/**
 * Start a shell of its own (when there is no prompt to run one from): another
 * driver, at an address of its own (`$d1`, `$d2`...). Its process entry is
 * configured right away, so that its prompt goes where it was asked for (it
 * takes the place of the entry's placeholder).
 */
export function handle$user_spawn(buche: Buche, obj: UserSpawnMessage): void {
    const id = `$d${++buche.driverSeq}`;
    buche.handle({
        type: "configure",
        from: [id, "$proc"],
        to: ["$term"],
        zone: obj.zone ?? null,
        label: obj.command,
    });
    buche.sendDriver({ type: "spawn", from: ["$term"], to: [id], command: obj.command });
}
