import type { Buche, OutM } from "../core.ts";
import type { BaseMessage, Json } from "./common.ts";

export interface DataMessage extends BaseMessage {
    type: "data";

    /** The data. */
    data: Json;
}

export async function* handle$data(buche: Buche, obj: DataMessage): AsyncIterable<OutM> {
    // TODO
}
