import { type OutM, type Buche } from "../core.ts";
import { type BaseMessage, type HighlightRange } from "./common.ts";

export interface EchoMessage extends BaseMessage {
  type: "echo";

  /** Text of the command. */
  text: string | null;

  /** Spans to colorize. */
  ranges: HighlightRange[];
}

export async function* handle$echo(
    buche: Buche,
    obj: EchoMessage
): AsyncIterable<OutM> {
  // TODO
}
