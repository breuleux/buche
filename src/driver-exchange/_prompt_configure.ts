import type { Buche } from "../core.ts";
import type { PromptConfiguration } from "../prompt.ts";
import type { BaseMessage, CreationInfo } from "./common.ts";

export interface PromptConfigureMessage extends BaseMessage, CreationInfo, PromptConfiguration {
    type: "prompt_configure";
}

export function handle$prompt_configure(buche: Buche, obj: PromptConfigureMessage): void {
    buche.configure("prompt", obj);
}
