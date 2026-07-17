import { Buche } from "../core.ts";
import { BaseMessage } from "./common.ts";

export interface TextMessage extends BaseMessage {
  type: "text";

  /** Stream on which the message was sent. */
  stream: "stdout" | "stderr";

  /** Text that was sent. */
  text: string;
}

export async function handle$text(
    buche: Buche,
    obj: TextMessage
): Promise<void> {
  // TODO
}
