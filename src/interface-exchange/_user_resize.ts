import type { Buche } from "../core.ts";
import { killable } from "../echo.ts";
import type { Entry } from "../entry.ts";

export interface UserResizeMessage {
    type: "user_resize";

    /** The cell's content area, in CSS pixels. */
    pixel: {
        height: number;
        width: number;
    };

    /** The terminal grid, in character cells, when the cell holds a pty. */
    pty?: {
        height: number;
        width: number;
    };

    entry: Entry;
}

export function handle$user_resize(buche: Buche, obj: UserResizeMessage): void {
    // The resize reaches the represented entry (the process) that owns the pty.
    const target = obj.entry.representative() ?? obj.entry;
    if (!killable(target.echo)) {
        return;
    }
    buche.sendDriver({
        type: "resize",
        pixel: obj.pixel,
        ...(obj.pty ? { pty: obj.pty } : {}),
        from: ["$term"],
        to: target.echo.address,
    });
}
