import type { Buche } from "../core.ts";
import { Echo, type EchoConfiguration } from "../echo.ts";
import type { BaseMessage } from "./common.ts";

export interface EchoMessage extends BaseMessage, EchoConfiguration {
    type: "echo";
}

export function handle$echo(buche: Buche, obj: EchoMessage): void {
    const entry = buche.get(obj.from, true);
    const zone = buche.findPlace(entry, obj);
    // INELEGANCE -- maybe coquille should be in charge of this
    // The entry inherited its color from its ancestors when it was created
    // (see Entry's constructor); keep it unless the message sets one — a bare
    // `new Echo(obj)` would reset it to the default.
    const echo = new Echo({ ...obj, color: obj.color ?? entry.echo.color });
    // Likewise the process may already have a live status (a cell_configure
    // before this echo); `new Echo` starts at `absent` — keep what it really
    // has, or the freshly installed echo handle shows the entry as stalled.
    echo.status = entry.echo.status;
    Object.assign(entry, { echo });
    buche.sendInterface({
        type: "install_echo",
        zone: zone,
        entry: entry,
    });
}
