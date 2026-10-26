import type { CellCommand } from "../cell.ts";
import type { Entry } from "../entry.ts";
import type { Target } from "../types.ts";
import type { BucheErrorFields } from "../utils.ts";

export interface UpdateCellMessage {
    type: "update_cell";

    /** Where to install the cell (a box, or a prompt), if it is new (null: it
     *  stays). */
    target?: Target | null;

    /** The component's entry (echo, cell, prompt, zones). */
    entry: Entry;

    /** Take the focus: a prompt, or a new cell (see PromptConfiguration.focus). */
    focus?: boolean;
}

export interface UpdateEntryMessage {
    type: "update_entry";

    /** The component's entry (echo, cell, prompt, zones). */
    entry: Entry;
}

export interface CellCommandMessage {
    type: "cell_command";

    command: CellCommand;
    entry: Entry;
}

export interface ProblemMessage extends BucheErrorFields {
    type: "problem";

    /** The component regarding which there was a problem, if one may be found. */
    entry?: Entry;
}

/** Union of every message type. */
export type OutgoingInterfaceMessage =
    | UpdateCellMessage
    | UpdateEntryMessage
    | CellCommandMessage
    | ProblemMessage;
