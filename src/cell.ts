import type { Prompt } from "./prompt.ts";
import { IdClass } from "./utils.ts";
import type { Zone } from "./zone.ts";

export interface CellConfiguration {
    /** The cell/tab label. */
    label?: string | null;

    /** Toggle whether the cell keeps or relinquishes focus when it is closed. */
    sticky?: boolean;

    /** If true, do not automatically focus the cell. */
    background?: boolean;
}

export class Echo extends IdClass {
    prompt: Prompt | null = null;
}

export class Cell extends IdClass implements CellConfiguration {
    prompt: Prompt | null = null;
    zone: Zone;

    label?: string | null;
    sticky?: boolean;
    background?: boolean;

    constructor(config: CellConfiguration, zone: Zone) {
        super();
        this.zone = zone;
        this.configure(config);
    }
    configure(config: CellConfiguration) {
        Object.assign(this, config);
    }

    makeZones(): Record<string, Zone> {
        return {};
    }
}
