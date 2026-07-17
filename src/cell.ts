import type { Address, Json } from "./driver-exchange/common.ts";
import type { Prompt } from "./prompt.ts";
import { IdClass } from "./utils.ts";
import type { Zone } from "./zone.ts";

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

export class Cell extends IdClass implements CellConfiguration {
    prompt: Prompt | null = null;
    zone: Zone;
    address: Address;

    label?: string | null;
    sticky?: boolean;
    background?: boolean;

    constructor(config: CellConfiguration, location: { zone: Zone; address: Address }) {
        super();
        this.zone = location.zone;
        this.address = location.address;
        this.configure(config);
    }
    configure(config: CellConfiguration) {
        Object.assign(this, config);
    }

    makeZones(parentZone: Zone): Record<string, Zone> {
        return {};
    }
}
