import type { Submission, SubmissionConfiguration } from "./types.ts";
import { applySubmission, WithId } from "./utils.ts";
import { PopZone, PromptZone } from "./zone.ts";

export interface PromptBinding {
    command: string;
    freeze?: boolean;
}

export type PromptBindings = Record<string, string | PromptBinding>;

export interface PromptConfiguration {
    /** Key-chord → action-name map for this prompt. */
    bindings?: PromptBindings;

    /**
     * The prompt as a submission: its content (what the user is typing, with
     * the cursor `position`) and its context (the marker text above the
     * editor).
     */
    submission?: SubmissionConfiguration;
}

export class Prompt extends WithId() implements PromptConfiguration {
    bindings: PromptBindings = {};
    submission: Submission = {
        content: { text: "", ranges: [], position: 0 },
        context: { text: "", ranges: [] },
    };
    /**
     * Ghost text: the most recent history entry extending the current content,
     * offered as a completion suffix (set by "prompt_highlight"); null when
     * there is nothing to suggest.
     */
    filigrane: string | null = null;

    zones: { main: PromptZone; pop: PopZone };

    constructor(config: PromptConfiguration) {
        super();
        this.configure(config);
        this.zones = {
            main: new PromptZone({ names: ["@"] }),
            pop: new PopZone({ names: ["pop"] }),
        };
    }

    configure(config: PromptConfiguration): void {
        this.bindings = config.bindings ?? this.bindings;
        applySubmission(this.submission, config.submission);
    }
}
