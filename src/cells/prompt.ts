import { Cell } from "../cell.ts";
import type { Submission, SubmissionConfiguration } from "../types.ts";
import { applySubmission } from "../utils.ts";

export interface PromptBinding {
    command: string;
    freeze?: boolean;
}

export type PromptBindings = Record<string, string | PromptBinding>;

export interface PromptConfiguration {
    /** Key-chord → action-name map for this prompt. */
    bindings?: PromptBindings;

    /**
     * The prompt's input: its content (what the user is typing, with the
     * `selection`, the ghost-text `filigrane` and its `editability`) and its
     * context (the marker text above the editor). Not to be confused with the
     * cell's `submission` (CellConfiguration), what a cell shows was submitted.
     */
    input?: SubmissionConfiguration;
}

/** A prompt: an editor the user types commands at. It takes no commands: it
 *  is configured (see `configurePrompt`). */
export class PromptCell extends Cell {
    readonly kind = "prompt";

    /** Key-chord → action-name map. */
    bindings: PromptBindings = {};

    /** What the user is typing, and the marker above it. */
    input: Submission = {
        content: { text: "", ranges: [], selection: { start: 0, end: 0 } },
        context: { text: "", ranges: [] },
    };

    /**
     * Machine bookkeeping (not configuration): the `request_id` of the last
     * parse sent for its content. A highlight echo (a configure with a
     * `request_id`) only applies while it matches. Null once an authoritative
     * configure took over (no parse is awaiting its answer).
     */
    request_id: string | null = null;

    /** Apply a prompt's configuration (its bindings and input). */
    configurePrompt(config: PromptConfiguration): void {
        this.bindings = config.bindings ?? this.bindings;
        applySubmission(this.input, config.input);
    }
}
