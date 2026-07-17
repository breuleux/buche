import type { CellCommand } from "../cell.ts";
import type { Buche, OutM } from "../core.ts";
import type { BaseMessage } from "./common.ts";

export interface CellSendMessage extends BaseMessage {
    type: "cell_send";

    /** Message to send to the cell. */
    message: CellCommand;
}

export async function* handle$cell_send(buche: Buche, obj: CellSendMessage): AsyncIterable<OutM> {
    const component = yield* buche.ensure("cell", obj);
    yield {
        type: "cell_command",
        command: obj.message,
        component: component,
    };
}
