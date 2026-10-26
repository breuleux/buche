import type { Submission, SubmissionConfiguration } from "./types.ts";
import { applySubmission, WithId } from "./utils.ts";

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
     * the `selection`, the ghost-text `filigrane` and its `editability`)
     * and its context (the marker text above the editor).
     */
    submission?: SubmissionConfiguration;
}

export class Prompt extends WithId() implements PromptConfiguration {
    bindings: PromptBindings = {};
    submission: Submission = {
        content: { text: "", ranges: [], selection: { start: 0, end: 0 } },
        context: { text: "", ranges: [] },
    };
    /**
     * Machine bookkeeping (not configuration): the `request_id` of the last
     * parse sent for this prompt's content. A highlight echo (prompt_configure
     * with a `request_id`) only applies while it matches. Null once an
     * authoritative configure took over (no parse is awaiting its answer).
     */
    request_id: string | null = null;

    constructor(config: PromptConfiguration) {
        super();
        this.configure(config);
    }

    configure(config: PromptConfiguration): void {
        this.bindings = config.bindings ?? this.bindings;
        applySubmission(this.submission, config.submission);
    }
}
