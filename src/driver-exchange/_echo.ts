import type { Buche } from "../core.ts";
import { Echo, type EchoConfiguration } from "../echo.ts";
import { BucheError } from "../utils.ts";
import type { BaseMessage } from "./common.ts";

export interface EchoMessage extends BaseMessage, EchoConfiguration {
    type: "echo";
}

export function handle$echo(buche: Buche, obj: EchoMessage): void {
    const component = buche.get(obj.from, true);
    if (component.echo || component.cell || component.prompt) {
        throw new BucheError({
            type: "buche_error",
            code: "exists",
            reason: `An element already exists at address ${obj.from}`,
        });
    }
    const { zone, prompt } = buche.findPlace(obj);
    const echo = new Echo(obj, { zone, prompt });
    Object.assign(component, { echo });
    buche.sendInterface({
        type: "update_component",
        zone: zone,
        component: component,
    });
}
