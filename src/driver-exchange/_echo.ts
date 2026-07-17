import { Echo } from "../cell.ts";
import type { Buche, OutM } from "../core.ts";
import { BucheError } from "../utils.ts";
import type { BaseMessage, HighlightRange } from "./common.ts";

export interface EchoMessage extends BaseMessage {
    type: "echo";

    /** Text of the command. */
    text: string | null;

    /** Spans to colorize. */
    ranges: HighlightRange[];
}

export async function* handle$echo(buche: Buche, obj: EchoMessage): AsyncIterable<OutM> {
    const component = buche.get(obj.from, true);
    if (component.echo || component.cell || component.prompt) {
        throw new BucheError({
            type: "error",
            code: "exists",
            reason: `An element already exists at address ${obj.from}`,
        });
    }
    const { zone, prompt } = buche.findPlace(obj);
    const echo = new Echo();
    echo.prompt = prompt;
    Object.assign(component, { echo });
    yield {
        type: "install_echo",
        zone: zone,
        component: component,
    };
}
