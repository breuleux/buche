import type { Buche } from "../core.ts";
import type { BaseMessage, Json } from "./common.ts";

export interface DataMessage extends BaseMessage {
    type: "data";

    /** The data. */
    data: Json;
}

export function handle$data(buche: Buche, obj: DataMessage): void {
    const component = buche.ensure("cell", obj);
    buche.sendInterface({
        type: "cell_command",
        command: {
            type: "data",
            data: obj.data,
        },
        component: component,
    });
}
