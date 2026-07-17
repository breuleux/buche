import type { CellCommand } from "../cell.ts";
import type { ComponentData } from "../core.ts";
import type { BucheErrorFields } from "../utils.ts";

/**
 * Install or update a component (echo, cell and/or prompt) at a location.
 *
 * This single message replaces the former `install_echo`, `install_cell`,
 * `install_prompt` and `update_status` messages: the interface (re)renders the
 * component from `component`, reading any status directly from its echo. The
 * zone the component lives in is available on the echo/cell/prompt themselves.
 */
export interface UpdateComponentMessage {
    type: "update_component";

    /** The component's current state (echo, cell, prompt, zones). */
    component: ComponentData;
}

export interface CellCommandMessage {
    type: "cell_command";

    command: CellCommand;
    component: ComponentData;
}

export interface ProblemMessage extends BucheErrorFields {
    type: "problem";

    /** The component regarding which there was a problem, if one may be found. */
    component?: ComponentData;
}

/** Union of every message type. */
export type OutgoingInterfaceMessage =
    | UpdateComponentMessage
    | CellCommandMessage
    | ProblemMessage;
