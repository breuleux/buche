import type { Cell } from "./cell.ts";
import type { Prompt } from "./prompt.ts";
import { WithId } from "./utils.ts";

export function zoneMap(zones: Array<Zone>): Record<string, Zone> {
    const rval: Record<string, Zone> = {};
    for (const zone of zones) {
        for (const name of zone.names) {
            rval[name] = zone;
        }
    }
    return rval;
}

export class Zone extends WithId() {
    names: Array<string>;
    parent?: Zone;

    constructor(name: string | Array<string>, parent?: Zone) {
        super();
        this.names = typeof name === "string" ? [name] : name;
        this.names.push(`Z${this.serialId}`);
        this.parent = parent;
    }

    effectiveZone(element: Cell | Prompt) {
        return this;
    }
}

export class PromptZone extends Zone {
    constructor(name: string | Array<string>, parent?: Zone) {
        super(name, parent);
        while (this.parent instanceof PromptZone) {
            this.parent = this.parent.parent;
        }
    }
}
