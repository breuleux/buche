import type { Prompt } from "./prompt.ts";
import type { Address, Json } from "./types.ts";
import { WithId } from "./utils.ts";

export interface ComponentStatus {
    status: "running" | "standby" | "done" | "error" | "unresponsive";
    code?: number | string | null;
}

export interface TextCommand {
    type: "text";
    stream: string;
    text: string;
}

export interface DataCommand {
    type: "data";
    data: Json;
}

export interface ExecCommand {
    type: "exec";
    code: string;
}

export type CellCommand = TextCommand | DataCommand | ExecCommand;

export interface CellConfiguration {
    /** The cell/tab label. */
    label?: string | null;

    /** Toggle whether the cell keeps or relinquishes focus when it is closed. */
    sticky?: boolean;

    /** If true, do not automatically focus the cell. */
    background?: boolean;
}

export class Cell extends WithId() implements CellConfiguration {
    prompt: Prompt | null = null;
    address: Address;

    label?: string | null;
    sticky?: boolean;
    background?: boolean;

    zones: Record<string, never>; // cells do not define zones currently

    constructor(config: CellConfiguration, location: { address: Address }) {
        super();
        this.address = location.address;
        this.configure(config);
        this.zones = {};
    }

    configure(config: CellConfiguration) {
        Object.assign(this, config);
    }
}
