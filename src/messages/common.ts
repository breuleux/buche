
/** Any JSON-serializable value (payloads exchanged over the FDs). */
export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };


export type Address = [string];

export type ZoneDescriptor = string;

export interface To {
    target: string;
}

export interface BaseMessage {
    /** Type of the message. */
    type: string;

    /** Address of the issuing process. */
    from: Address;

    /** Target of the message. */
    to: To;
}
