import { PromptConfiguration } from "../prompt.ts";
import { Buche } from "../core.ts";
import { BaseMessage } from "./common.ts";

export interface PromptConfigureMessage extends BaseMessage, PromptConfiguration {
  type: "prompt_configure";
}

export async function handle$prompt_configure(
    buche: Buche,
    obj: PromptConfigureMessage
): Promise<void> {
  // TODO
}
