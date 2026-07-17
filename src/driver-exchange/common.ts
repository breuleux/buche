/** Any JSON-serializable value (payloads exchanged over the FDs). */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type Address = Array<string>;
export type To = Address;

export type ZoneDescriptor = string;

export interface BaseMessage {
    /** Type of the message. */
    type: string;

    /** Address of the issuing process. */
    from: Address;

    /** Target of the message. */
    to: To;
}

export interface CreationInfo {
    /** Address of the issuing process. */
    from: Address;

    /** Which zone to put the element in. */
    zone?: ZoneDescriptor | null;
}

/** A syntax-highlight span over the prompt text */
export interface HighlightRange {
    /** Inclusive start offset into the prompt text. */
    start: number;

    /** Exclusive end offset. */
    end: number;

    /** CSS class. */
    cls: string;
}
