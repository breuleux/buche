import { type CellCommand, commandKind } from "../cell.ts";
import type { Buche } from "../core.ts";
import type { BaseMessage } from "./common.ts";

export interface SendMessage extends BaseMessage {
    type: "send";

    /** Message to send to the cell. */
    message: CellCommand;
}

export function handle$send(buche: Buche, obj: SendMessage): void {
    const entry = buche.output(obj, commandKind(obj.message));
    buche.sendInterface({
        type: "cell_command",
        command: obj.message,
        entry: entry,
    });
}
