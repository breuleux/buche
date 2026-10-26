import type { Address, To, ZoneDescriptor } from "../types.ts";

export type {
    Action,
    Address,
    Json,
    Selection,
    TextPart,
    To,
    ZoneDescriptor,
} from "../types.ts";

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

    /**
     * Address of the entry the zone is relative to (e.g. "right": right of
     * it), instead of the one `from` implies (its closest ancestor showing
     * something: for a command, the prompt it came from). E.g. a command's
     * output beside the cell the command was performed on. An entry that
     * shows nothing itself (a process) stands for what it shows. Like `zone`,
     * only heeded when the entry is created; ignored if nothing shows there.
     */
    anchor?: Address | null;
}
