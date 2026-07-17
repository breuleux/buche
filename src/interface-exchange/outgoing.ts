import type { CellCommand } from "../cell.ts";
import type { Post } from "../post.ts";
import type { BucheErrorFields } from "../utils.ts";
import type { Zone } from "../zone.ts";

export interface UpdateComponentMessage {
    type: "update_component";

    /** The zone in which to install or move the component. */
    zone?: Zone | null;

    /** The component's current state (echo, cell, prompt, zones). */
    component: Post;
}

export interface CellCommandMessage {
    type: "cell_command";

    command: CellCommand;
    component: Post;
}

export interface ProblemMessage extends BucheErrorFields {
    type: "problem";

    /** The component regarding which there was a problem, if one may be found. */
    component?: Post;
}

/** Union of every message type. */
export type OutgoingInterfaceMessage =
    | UpdateComponentMessage
    | CellCommandMessage
    | ProblemMessage;
