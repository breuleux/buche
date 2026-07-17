import type { StyledText } from "./types.ts";
import { WithId } from "./utils.ts";
import { PromptZone } from "./zone.ts";

export type PromptBindings = Record<string, string>;

export interface PromptConfiguration {
    /** Key-chord → action-name map for this prompt. */
    bindings?: PromptBindings;

    /** HTML for the prompt's leading label/marker. */
    prompt?: StyledText;

    /** Prompt contents */
    content?: StyledText;
}

export class Prompt extends WithId() implements PromptConfiguration {
    bindings: PromptBindings = {};
    prompt: StyledText = { text: "", ranges: [] };
    content: StyledText = { text: "", ranges: [], position: 0 };
    /**
     * Ghost text: the most recent history entry extending the current content,
     * offered as a completion suffix (set by "prompt_highlight"); null when
     * there is nothing to suggest.
     */
    filigrane: string | null = null;

    zones: { main: PromptZone };

    constructor(config: PromptConfiguration) {
        super();
        this.configure(config);
        this.zones = {
            main: new PromptZone({ names: ["@"] }),
        };
    }

    configure(config: PromptConfiguration): void {
        this.prompt = config.prompt ?? this.prompt;
        this.bindings = config.bindings ?? this.bindings;
        if (config.content) {
            this.content.text = config.content.text;
            this.content.ranges = config.content.ranges;
            this.content.position = config.content.position ?? this.content.position;
        }
    }
}
