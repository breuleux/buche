import { type Buche } from "../core.ts";
import { type BaseMessage, type HighlightRange } from "./common.ts";

export interface EchoMessage extends BaseMessage {
  type: "echo";

  /** Associates the echo with an existing prompt. */
  prompt_id: string | null;

  /** Text of the command. */
  text: string | null;

  /** Spans to colorize. */
  ranges: HighlightRange[];
}

export async function handle$echo(
    buche: Buche,
    obj: EchoMessage
): Promise<void> {
  // TODO
}
