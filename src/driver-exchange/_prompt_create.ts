import { type PromptConfiguration } from "../prompt.ts";
import { type Buche } from "../core.ts";
import { type BaseMessage, type ZoneDescriptor } from "./common.ts";

export interface PromptCreateMessage extends BaseMessage, PromptConfiguration {
  type: "prompt_create";

  /** Associates the prompt with another existing prompt. */
  prompt_id?: string | null;

  /** Which zone to put the prompt in. */
  zone?: ZoneDescriptor | null;
}

export async function handle$prompt_create(
    buche: Buche,
    obj: PromptCreateMessage
): Promise<void> {
  // TODO
}
