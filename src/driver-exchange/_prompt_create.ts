import { type OutM, type Buche } from "../core.ts";
import { Prompt, type PromptConfiguration } from "../prompt.ts";
import { type BaseMessage, type CreationInfo } from "./common.ts";

export interface PromptCreateMessage extends BaseMessage, CreationInfo, PromptConfiguration {
    type: "prompt_create";
}

export async function* handle$prompt_create(
    buche: Buche,
    obj: PromptCreateMessage,
): AsyncIterable<OutM> {
    const component = buche.fresh(obj.from);
    const { zone } = buche.findPlace(obj);
    const prompt = new Prompt(obj, zone);
    Object.assign(component, { prompt, zones: prompt.makeZones() });
    yield {
        type: "install_prompt",
        zone: zone,
        component: component,
    };
}
