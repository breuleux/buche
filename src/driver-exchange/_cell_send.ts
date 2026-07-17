import { Buche } from "../core.ts";
import { DataMessage } from "./_data.ts";
import { TextMessage } from "./_text.ts";
import { BaseMessage } from "./common.ts";

export interface ExecCellMessage {
  type: "exec";
  code: string;
}

export type CellMessage = ExecCellMessage | TextMessage | DataMessage;

export interface CellSendMessage extends BaseMessage {
  type: "cell_send";

  /** Message to send to the cell. */
  message: CellMessage;
}

export async function handle$cell_send(
    buche: Buche,
    obj: CellSendMessage
): Promise<void> {
  // TODO
}
