import { type PromptConfiguration } from "../prompt.ts";
import { type Buche } from "../core.ts";
import { type BaseMessage } from "./common.ts";

export interface PromptConfigureMessage extends BaseMessage, PromptConfiguration {
  type: "prompt_configure";
}

export async function handle$prompt_configure(
    buche: Buche,
    obj: PromptConfigureMessage
): Promise<void> {
  // TODO
}
