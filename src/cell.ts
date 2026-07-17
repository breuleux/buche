import type { Json } from "./types.ts";
import { WithId } from "./utils.ts";

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
    /** Toggle whether the cell keeps or relinquishes focus when it is closed. */
    sticky?: boolean;

    /** If true, do not automatically focus the cell. */
    background?: boolean;
}

export class Cell extends WithId() implements CellConfiguration {
    sticky?: boolean;
    background?: boolean;

    zones: Record<string, never>; // cells do not define zones currently

    constructor(config: CellConfiguration) {
        super();
        this.configure(config);
        this.zones = {};
    }

    configure(config: CellConfiguration) {
        Object.assign(this, config);
    }
}
