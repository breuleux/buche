import { type Buche } from "../core.ts";
import { type DataMessage } from "./_data.ts";
import { type TextMessage } from "./_text.ts";
import { type BaseMessage } from "./common.ts";

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
