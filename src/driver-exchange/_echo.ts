import type { Buche } from "../core.ts";
import { Echo, type EchoConfiguration } from "../echo.ts";
import type { BaseMessage } from "./common.ts";

export interface EchoMessage extends BaseMessage, EchoConfiguration {
    type: "echo";
}

export function handle$echo(buche: Buche, obj: EchoMessage): void {
    const component = buche.get(obj.from, true);
    const { zone } = buche.findPlace(obj);
    const echo = new Echo(obj);
    Object.assign(component, { echo });
    buche.sendInterface({
        type: "update_component",
        zone: zone,
        component: component,
    });
}
