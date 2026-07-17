export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type Address = Array<string>;
export type To = Address;

export type ZoneDescriptor = string;

export type Accent = string;

/** A syntax-highlight span over the prompt text */
export interface HighlightRange {
    /**
     * Inclusive start offset. `null` means the start of the text (offset 0); in
     * an editable prompt it is an *open* boundary that also absorbs text the user
     * inserts at the very beginning.
     */
    start: number | null;

    /**
     * Exclusive end offset. `null` means the end of the text; in an editable
     * prompt it is an *open* boundary that also absorbs text the user appends.
     */
    end: number | null;

    /** Style. */
    style: Accent;
}

export interface StyledText {
    /** Text to style. */
    text: string;

    /** Spans to colorize. */
    ranges: HighlightRange[];
}

export interface InteractiveStyledText extends StyledText {
    /**
     * Editability status of the text. Defaults to "editable" in a prompt,
     * "readonly" in an echo (only "readonly" is supported in echos for now).
     * "frozen" — set when a freezing binding fires — acts like "readonly",
     * but is styled differently to denote a temporary condition.
     */
    editability?: "readonly" | "editable" | "frozen";

    /** Position of the cursor, if applicable. */
    position?: number | null;

    /** Ghost text displayed next to the text as a completion suggestion. */
    filigrane?: string;
}

export interface SubmissionConfiguration {
    /** Content text of the submission */
    content?: InteractiveStyledText;

    /** Context of the submission (prompt text) */
    context?: StyledText;
}

export interface Submission {
    /** Content text of the submission */
    content: InteractiveStyledText;

    /** Context of the submission (prompt text) */
    context: StyledText;
}
