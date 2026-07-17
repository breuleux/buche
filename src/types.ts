export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type Address = Array<string>;
export type To = Address;

export type ZoneDescriptor = string;

/** A syntax-highlight span over the prompt text */
export interface HighlightRange {
    /** Inclusive start offset into the prompt text. */
    start: number;

    /** Exclusive end offset. */
    end: number;

    /** CSS class. */
    cls: string;
}

export interface ColorDef {
    /** OKLCH hue */
    hue?: number;

    /** OKLCH chroma */
    chroma?: number;
}
