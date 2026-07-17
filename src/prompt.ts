import type { Address } from "./driver-exchange/common.ts";
import { IdClass } from "./utils.ts";
import { Zone } from "./zone.ts";

export type PromptBindings = Record<string, string>;

export interface PromptColor {
    /** OKLCH hue */
    hue?: number;

    /** OKLCH chroma */
    chroma?: number;
}

export interface PromptConfiguration {
    /** The prompt/tab label. */
    label?: string | null;

    /** Key-chord → action-name map for this prompt. */
    bindings?: PromptBindings;

    /** Accent color for the prompt. */
    color?: PromptColor;

    /** HTML for the prompt's leading label/marker. */
    prompt_html?: string;
}

export class Prompt extends IdClass implements PromptConfiguration {
    zone: Zone;
    address: Address;

    label?: string | null;
    bindings?: PromptBindings;
    color?: PromptColor;
    prompt_html?: string;

    constructor(config: PromptConfiguration, location: { zone: Zone; address: Address }) {
        super();
        this.zone = location.zone;
        this.address = location.address;
        this.configure(config);
    }
    configure(config: PromptConfiguration): void {
        Object.assign(this, config);
    }

    makeZones(): Record<string, Zone> {
        return { "@": new Zone() };
    }
}
