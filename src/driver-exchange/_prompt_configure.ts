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
    // Record the zone the prompt sits in, by name, so descendants' named
    // lookups (e.g. "@tab") resolve to *this* zone instead of bubbling to a
    // same-named zone elsewhere: every TabbedZone answers to "tab", and the
    // root registry keeps only one. The prompt's own "@" (its log) and "pop"
    // were defined by the Prompt and win over the zone's names.
    for (const name of zone.names) {
        entry.zones[name] ??= zone;
    }
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
