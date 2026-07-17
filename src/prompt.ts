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

    /**
     * Ghost text (history suggestion): echoed back by "prompt_configure"
     * answering a parse, and set or cleared by an authoritative one (explicit
     * null — e.g. dropped along with the text when the prompt is submitted).
     * Absent: left as is.
     */
    filigrane?: string | null;
}

export class Prompt extends WithId() implements PromptConfiguration {
    bindings: PromptBindings = {};
    submission: Submission = {
        content: { text: "", ranges: [], position: 0 },
        context: { text: "", ranges: [] },
    };
    /**
     * Ghost text: the most recent history entry extending the current content,
     * offered as a completion suffix (echoed by "prompt_configure"); null when
     * there is nothing to suggest.
     */
    filigrane: string | null = null;

    /**
     * Machine bookkeeping (not configuration): the `request_id` of the last
     * parse sent for this prompt's content. A highlight echo (prompt_configure
     * with a `request_id`) only applies while it matches. Null once an
     * authoritative configure took over (no parse is awaiting its answer).
     */
    request_id: string | null = null;

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
        if (config.filigrane !== undefined) {
            this.filigrane = config.filigrane;
        }
    }
}
