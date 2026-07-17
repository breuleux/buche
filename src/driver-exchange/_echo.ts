import type { Buche } from "../core.ts";
import { Echo, type EchoConfiguration } from "../echo.ts";
import type { BaseMessage } from "./common.ts";

export interface EchoMessage extends BaseMessage, EchoConfiguration {
    type: "echo";
}

export function handle$echo(buche: Buche, obj: EchoMessage): void {
    const entry = buche.get(obj.from, true);
    const zone = buche.findPlace(entry, obj);
    const echo = new Echo(obj);
    Object.assign(entry, { echo });
    buche.sendInterface({
        type: "install_echo",
        zone: zone,
        entry: entry,
    });
}
