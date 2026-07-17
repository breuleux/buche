import type { Buche } from "../core.ts";
import type { EchoConfiguration } from "../echo.ts";
import { Prompt, type PromptConfiguration } from "../prompt.ts";
import type { BaseMessage, CreationInfo } from "./common.ts";

export interface PromptConfigureMessage
    extends BaseMessage,
        CreationInfo,
        EchoConfiguration,
        PromptConfiguration {
    type: "prompt_configure";
}

export function handle$prompt_configure(buche: Buche, obj: PromptConfigureMessage): void {
    const entry = buche.ensure(obj);
    const zone = buche.findPlace(entry, obj);
    if (entry.prompt) {
        entry.prompt.configure(obj);
    } else {
        const prompt = new Prompt(obj);
        entry.setPrompt(prompt);
    }
    entry.echo.status = { status: "running" };
    buche.sendInterface({
        type: "update_prompt",
        zone: zone,
        entry: entry,
    });
}
