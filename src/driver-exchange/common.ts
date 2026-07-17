import type { Address, To, ZoneDescriptor } from "../types.ts";

export type { Address, HighlightRange, Json, To, ZoneDescriptor } from "../types.ts";

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
