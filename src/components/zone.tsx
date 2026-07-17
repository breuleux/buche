import type { DomProps } from "myjsx/jsx-runtime";
import { WithId } from "../utils.ts";
import { TabbedZone, type Zone } from "../zone.ts";
import { TabPane } from "./tab-pane.tsx";

export function extractZones(root: HTMLElement): Array<Zone> {
    // Not setting parents, we don't really expect nested zones here
    const zones: Array<Zone> = [];
    const walk = (node: Element) => {
        if (node instanceof ZoneElement) {
            zones.push(...node.contributeZones());
        }
        for (const child of node.children) {
            walk(child);
        }
    };
    walk(root);
    return zones;
}

export class ZoneElement extends WithId(HTMLElement) {
    // Names given explicitly to the constructor. When absent (e.g. the element
    // was upgraded from declarative markup like `<tabbed-zone names="left">`),
    // the `names` getter falls back to the `names` attribute.
    names: Array<string>;

    constructor(name: string | Array<string> | null = null) {
        super();
        if (!name) {
            name = this.getAttribute("names");
        }
        if (name !== null) {
            this.names = typeof name === "string" ? name.split(/ +/) : [...name];
        } else {
            this.names = [];
        }
        this.names.push(`Z${this.serialId}`);
    }

    contributeZones(): Array<Zone> {
        return [];
    }
}

export class TabbedZoneElement extends ZoneElement {
    tabs: TabPane = new TabPane();

    connectedCallback(): void {
        this.ensureSetup();
    }

    ensureSetup() {
        const tb = this.tabs;
        this.tabs.setAttribute("hide-single", "");
        // A zone is a focusable container (see focus.ts): navigating into it
        // lands on the cell or prompt last focused within it.
        if (!this.hasAttribute("focusable")) {
            this.setAttribute("focusable", "zone");
        }
        if (!this.contains(tb)) {
            this.appendChild(tb);
            // An empty zone takes no place (a hidden pane gets no grid track,
            // see grid.tsx): the zone only shows up once something is added.
            tb.addEventListener("tabschange", () => this.syncEmpty());
        }
        this.syncEmpty();
    }

    private syncEmpty(): void {
        this.hidden = this.tabs.isEmpty;
    }

    contributeZones(): Array<Zone> {
        return [new TabbedZone({ names: this.names, element: this.tabs })];
    }
}

if (typeof customElements !== "undefined") {
    if (!customElements.get("tabbed-zone")) {
        customElements.define("base-zone", ZoneElement);
        customElements.define("tabbed-zone", TabbedZoneElement);
    }
}

declare module "myjsx/jsx-runtime" {
    namespace JSX {
        interface CustomElements {
            "base-zone": DomProps<ZoneElement>;
            "tabbed-zone": DomProps<TabbedZoneElement>;
        }
    }
}
