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

    /** Position of the cursor, if applicable. */
    position?: number | null;
}

export interface SubmissionConfiguration {
    /** Content text of the submission */
    content?: StyledText;

    /** Context of the submission (prompt text) */
    context?: StyledText;
}

export interface Submission {
    /** Content text of the submission */
    content: StyledText;

    /** Context of the submission (prompt text) */
    context: StyledText;
}
