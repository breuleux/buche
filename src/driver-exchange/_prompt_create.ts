import { type OutM, type Buche } from "../core.ts";
import { type PromptConfiguration } from "../prompt.ts";
import { type BaseMessage, type ZoneDescriptor } from "./common.ts";

export interface PromptCreateMessage extends BaseMessage, PromptConfiguration {
  type: "prompt_create";

  /** Prompt id. */
  prompt_id: string;

  /** Associates the prompt with another existing prompt. */
  parent_prompt?: string | null;

  /** Which zone to put the prompt in. */
  zone?: ZoneDescriptor | null;
}

export async function* handle$prompt_create(
    buche: Buche,
    obj: PromptCreateMessage
): AsyncIterable<OutM> {
  // TODO
}
