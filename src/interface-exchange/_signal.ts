import type { Buche } from "../core.ts";
import type { Entry } from "../entry.ts";

export interface SignalMessage {
    type: "signal";
    code: number;
    entry: Entry;
}

export function handle$signal(buche: Buche, obj: SignalMessage): void {
    buche.sendDriver({
        type: "signal",
        code: obj.code,
        from: ["$term"],
        to: obj.entry.echo.address,
    });
}
