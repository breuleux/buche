import type { Cell } from "./cell.ts";
import type { Prompt } from "./prompt.ts";
import { IdClass } from "./utils.ts";

export class Zone extends IdClass {
    parent?: Zone;

    constructor(parent?: Zone) {
        super();
        this.parent = parent;
    }

    effectiveZone(element: Cell | Prompt) {
        return this;
    }
}

export class PromptZone extends Zone {
    constructor(parent?: Zone) {
        super(parent);
        while (this.parent instanceof PromptZone) {
            this.parent = this.parent.parent;
        }
    }
}
