import type { Cell } from "../cell.ts";
import type { Buche, OutM } from "../core.ts";
import type { Prompt } from "../prompt.ts";

export interface SignalMessage {
    type: "signal";
    code: number;
    element: Prompt | Cell;
}

export async function* handle$signal(buche: Buche, obj: SignalMessage): AsyncIterable<OutM> {
    yield {
        type: "signal",
        code: obj.code,
        from: ["$term"],
        to: obj.element.address,
    };
}
