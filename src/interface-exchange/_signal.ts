import type { Cell } from "../cell.ts";
import type { Buche } from "../core.ts";
import type { Prompt } from "../prompt.ts";

export interface SignalMessage {
    type: "signal";
    code: number;
    element: Prompt | Cell;
}

export function handle$signal(buche: Buche, obj: SignalMessage): void {
    buche.sendDriver({
        type: "signal",
        code: obj.code,
        from: ["$term"],
        to: obj.element.address,
    });
}
