import type { Buche, OutM } from "../core.ts";
import type { BaseMessage, Json } from "./common.ts";

export interface DataMessage extends BaseMessage {
    type: "data";

    /** The data. */
    data: Json;
}

export async function* handle$data(buche: Buche, obj: DataMessage): AsyncIterable<OutM> {
    const component = buche.get(obj.from);
    yield {
        type: "cell_command",
        command: {
            type: "data",
            data: obj.data,
        },
        component: component,
    };
}
