import type { Accent, Address, HighlightRange } from "./types.ts";
import { WithId } from "./utils.ts";
import { PromptZone } from "./zone.ts";

export type PromptBindings = Record<string, string>;

export interface PromptConfiguration {
    /** The prompt/tab label. */
    label?: string | null;

    /** Key-chord → action-name map for this prompt. */
    bindings?: PromptBindings;

    /** Accent color for the prompt. */
    color?: Accent;

    /** HTML for the prompt's leading label/marker. */
    prompt_html?: string;

    /** Text in the prompt. */
    text?: string | null;

    /** Spans to colorize. */
    ranges?: HighlightRange[];
}

export class Prompt extends WithId() implements PromptConfiguration {
    address: Address;

    label?: string | null;
    bindings?: PromptBindings;
    color?: Accent;
    prompt_html?: string;

    zones: { main: PromptZone };

    constructor(config: PromptConfiguration, location: { address: Address }) {
        super();
        this.address = location.address;
        this.configure(config);
        this.zones = {
            main: new PromptZone("@"),
        };
    }

    configure(config: PromptConfiguration): void {
        Object.assign(this, config);
    }
}
