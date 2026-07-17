import { type OutM, type Buche } from "../core.ts";
import { type PromptConfiguration } from "../prompt.ts";
import { type BaseMessage, type CreationInfo } from "./common.ts";

export interface PromptCreateMessage extends BaseMessage, CreationInfo, PromptConfiguration {
  type: "prompt_create";
}

export async function* handle$prompt_create(
    buche: Buche,
    obj: PromptCreateMessage
): AsyncIterable<OutM> {
  // TODO
}
