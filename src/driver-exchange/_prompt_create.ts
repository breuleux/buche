import { Buche, PromptConfiguration } from "../core.ts";
import { BaseMessage, ZoneDescriptor } from "./common.ts";

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
