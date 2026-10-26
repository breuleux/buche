import type { SubmissionConfiguration } from "./types.ts";

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
