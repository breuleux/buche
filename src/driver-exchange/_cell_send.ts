import type { CellCommand } from "../cell.ts";
import type { Buche, OutM } from "../core.ts";
import type { BaseMessage } from "./common.ts";

export interface CellSendMessage extends BaseMessage {
    type: "cell_send";

    /** Message to send to the cell. */
    message: CellCommand;
}

export async function* handle$cell_send(buche: Buche, obj: CellSendMessage): AsyncIterable<OutM> {
    const component = buche.get(obj.from);
    yield {
        type: "cell_send",
        command: obj.message,
        component: component,
    };
}
