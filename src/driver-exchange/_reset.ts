import type { Buche } from "../core.ts";
import type { BaseMessage } from "./common.ts";

/**
 * Start the cells at and under `from` over, blank: a frame throws its GUI
 * away for a fresh iframe, with no DOM, script state, handlers or cached
 * resources left from the old one (send them again), and keeps the focus if
 * the old one had it; a terminal (or a placeholder's) is cleared, screen and
 * scrollback. Prompts, and entries that show nothing, are left alone. It
 * creates nothing: only the cells that exist are reset, and an address with
 * nothing at it is ignored. E.g. a program restarting its child resets its
 * own address (`["$proc"]`) to reset whichever views the child had.
 */
export interface ResetMessage extends BaseMessage {
    type: "reset";

    /** Whether the cells under `from` are reset too (default: true). */
    propagate?: boolean;
}

export function handle$reset(buche: Buche, obj: ResetMessage): void {
    const h = buche.hierarchy.getAt(obj.from, false);
    const entries = h ? (obj.propagate === false ? [h] : h.walk()) : [];
    for (const entry of entries) {
        const kind = entry.cell.kind;
        if (kind === "terminal" || kind === "frame" || kind === "pending") {
            buche.sendInterface({ type: "reset_cell", entry });
        }
    }
}
