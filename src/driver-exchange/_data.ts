import { Buche } from "../core.ts";
import { BaseMessage, Json } from "./common.ts";

export interface DataMessage extends BaseMessage {
  type: "data";

  /** The data. */
  data: Json;
}

export async function handle$data(
    buche: Buche,
    obj: DataMessage
): Promise<void> {
  // TODO
}
