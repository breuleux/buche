export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type Address = Array<string>;
export type To = Address;

export type ZoneDescriptor = string;

export type Accent = string;

/** A syntax-highlight span over the prompt text */
export interface HighlightRange {
    /** Inclusive start offset into the prompt text. */
    start: number;

    /** Exclusive end offset. */
    end: number;

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
