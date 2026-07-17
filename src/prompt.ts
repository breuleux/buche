import type { Address, StyledText } from "./types.ts";
import { WithId } from "./utils.ts";
import { PromptZone } from "./zone.ts";

export type PromptBindings = Record<string, string>;

export interface PromptConfiguration {
    /** Key-chord → action-name map for this prompt. */
    bindings?: PromptBindings;

    /** HTML for the prompt's leading label/marker. */
    prompt_html?: string;

    /** Prompt contents */
    content?: StyledText;
}

export class Prompt extends WithId() implements PromptConfiguration {
    address: Address;

    bindings: PromptBindings = {};
    prompt_html: string = "";
    content: StyledText = { text: "", ranges: [], position: 0 };

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
        this.prompt_html = config.prompt_html ?? this.prompt_html;
        this.bindings = config.bindings ?? this.bindings;
        if (config.content) {
            this.content.text = config.content.text;
            this.content.ranges = config.content.ranges;
            this.content.position = config.content.position ?? this.content.position;
        }
    }
}
