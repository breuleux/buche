import type { Buche, OutM } from "../core.ts";
import type { PromptConfiguration } from "../prompt.ts";
import type { BaseMessage, CreationInfo } from "./common.ts";

export interface PromptConfigureMessage extends BaseMessage, CreationInfo, PromptConfiguration {
    type: "prompt_configure";
}

export async function* handle$prompt_configure(
    buche: Buche,
    obj: PromptConfigureMessage,
): AsyncIterable<OutM> {
    yield* buche.configure("prompt", obj);
}
