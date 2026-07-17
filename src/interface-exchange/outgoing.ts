import type { CellCommand } from "../cell.ts";
import type { Entry } from "../entry.ts";
import type { BucheErrorFields } from "../utils.ts";
import type { Zone } from "../zone.ts";

export interface UpdatePromptMessage {
    type: "update_prompt";

    /** The zone in which to install or move the component. */
    zone?: Zone | null;

    /** The component's entry (echo, cell, prompt, zones). */
    entry: Entry;
}

export interface InstallEchoMessage {
    type: "install_echo";

    /** The zone in which to install the echo. */
    zone?: Zone | null;

    /** The component's entry (echo, cell, prompt, zones). */
    entry: Entry;
}

export interface UpdateCellMessage {
    type: "update_cell";

    /** The zone in which to install or move the component. */
    zone?: Zone | null;

    /** The component's entry (echo, cell, prompt, zones). */
    entry: Entry;
}

export interface UpdateComponentMessage {
    type: "update_component";

    /** The zone in which to install or move the component. */
    zone?: Zone | null;

    /** The component's entry (echo, cell, prompt, zones). */
    component: Entry;
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
    | InstallEchoMessage
    | UpdatePromptMessage
    | UpdateCellMessage
    | UpdateComponentMessage
    | CellCommandMessage
    | ProblemMessage;
