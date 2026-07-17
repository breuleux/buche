import type { DomProps } from "myjsx/jsx-runtime";
import type { Cell } from "../cell.ts";
import type { Prompt } from "../prompt.ts";
import { WithId } from "../utils.ts";

export function extractZones(root: HTMLElement): Array<Zone> {
    // Not setting parents, we don't really expect nested zones here
    const zones: Array<Zone> = [];
    const walk = (node: Element) => {
        if (node instanceof Zone) {
            zones.push(node);
        }
        for (const child of node.children) {
            walk(child);
        }
    };
    walk(root);
    return zones;
}

// export function extractZones(root: HTMLElement): Array<Zone> {
//     const zones: Array<Zone> = [];
//     const walk = (node: Element, parent?: Zone) => {
//         let nearestZone = parent;
//         if (node instanceof Zone) {
//             let effectiveParent = parent;
//             if (node instanceof PromptZone) {
//                 while (effectiveParent instanceof PromptZone) {
//                     effectiveParent = effectiveParent.parent;
//                 }
//             }
//             node.parent = effectiveParent;
//             zones.push(node);
//             nearestZone = node;
//         }
//         for (const child of node.children) {
//             walk(child, nearestZone);
//         }
//     };
//     walk(root);
//     return zones;
// }

export function zoneMap(zones: Array<Zone>): Record<string, Zone> {
    const rval: Record<string, Zone> = {};
    for (const zone of zones) {
        for (const name of zone.names) {
            rval[name] = zone;
        }
    }
    return rval;
}

export class Zone extends WithId(HTMLElement) {
    names: Array<string>;
    parent?: Zone;

    constructor(name: string | Array<string>, parent?: Zone) {
        super();
        this.names = typeof name === "string" ? name.split(/ +/) : name;
        this.names.push(`Z${this.serialId}`);
        this.parent = parent;
    }

    effectiveZone(element: Cell | Prompt) {
        return this;
    }
}

export class TabbedZone extends Zone {}

export class LogZone extends Zone {}

export class SingletonZone extends Zone {}

export class PromptZone extends Zone {
    constructor(name: string | Array<string>, parent?: Zone) {
        super(name, parent);
        while (this.parent instanceof PromptZone) {
            this.parent = this.parent.parent;
        }
    }
}

if (typeof customElements !== "undefined") {
    if (!customElements.get("tabbed-zone")) {
        customElements.define("base-zone", Zone);
        customElements.define("tabbed-zone", TabbedZone);
        customElements.define("log-zone", LogZone);
        customElements.define("singleton-zone", SingletonZone);
        customElements.define("prompt-zone", PromptZone);
    }
}

declare module "myjsx/jsx-runtime" {
    namespace JSX {
        interface CustomElements {
            "base-zone": DomProps<Zone>;
            "tabbed-zone": DomProps<TabbedZone>;
            "log-zone": DomProps<LogZone>;
            "singleton-zone": DomProps<SingletonZone>;
            "prompt-zone": DomProps<PromptZone>;
        }
    }
}
