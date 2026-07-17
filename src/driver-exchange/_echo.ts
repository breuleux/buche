import { Echo, type EchoConfiguration } from "../cell.ts";
import type { Buche, OutM } from "../core.ts";
import { BucheError } from "../utils.ts";
import type { BaseMessage } from "./common.ts";

export interface EchoMessage extends BaseMessage, EchoConfiguration {
    type: "echo";
}

export async function* handle$echo(buche: Buche, obj: EchoMessage): AsyncIterable<OutM> {
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
    yield {
        type: "update_component",
        component: component,
    };
}
