import type { CellCommand } from "../cell.ts";
import type { Buche } from "../core.ts";
import type { BaseMessage } from "./common.ts";

export interface CellSendMessage extends BaseMessage {
    type: "cell_send";

    /** Message to send to the cell. */
    message: CellCommand;
}

export function handle$cell_send(buche: Buche, obj: CellSendMessage): void {
    const component = buche.ensure("cell", obj);
    buche.sendInterface({
        type: "cell_command",
        command: obj.message,
        component: component,
    });
}
