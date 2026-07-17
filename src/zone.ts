import { BucheTerm } from "./components/buche-term.tsx";
import { EchoBox } from "./components/echo-box.tsx";
import type { EmbeddedTerm } from "./components/embedded-term.tsx";
import type {
    PromptCommandEvent,
    PromptTextChangeEvent,
} from "./components/prompt-collection.tsx";
import type { TabPane } from "./components/tab-pane.tsx";
import type { Entry } from "./entry.ts";
import type { BucheInterface as Interface } from "./interface.tsx";
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

export interface ZoneConfiguration {
    names: Array<string>;
    element?: HTMLElement;
}

export class Zone extends WithId() {
    names: Array<string>;
    element?: HTMLElement;

    constructor(args: ZoneConfiguration) {
        super();
        this.names = args.names || [];
        this.element = args.element;
        this.names.push(`Z${this.serialId}`);
    }

    installEcho(ifc: Interface, entry: Entry): HTMLElement {
        throw Error("not implemented");
    }

    installCell(ifc: Interface, entry: Entry): HTMLElement {
        throw Error("not implemented");
    }

    installPrompt(ifc: Interface, entry: Entry): HTMLElement {
        throw Error("not implemented");
    }
}

export class TabbedZone extends Zone {
    declare element: TabPane;

    installPrompt(ifc: Interface, entry: Entry): HTMLElement {
        const row = this.element.addTab(entry);
        const pz = entry.prompt!.zones.main;
        const bt = new BucheTerm();
        bt.prompts.addEventListener("command", (event: PromptCommandEvent) => {
            const entry = event.detail.entry;
            ifc.interactions.push({
                type: "user_command",
                entry: entry,
                text: event.detail.text,
                position: event.detail.position,
                command: event.detail.command,
            });
        });
        bt.prompts.addEventListener("textchange", (event: PromptTextChangeEvent) => {
            const entry = event.detail.entry;
            ifc.interactions.push({
                type: "user_input",
                entry: entry,
                text: event.detail.text,
                position: event.detail.position,
            });
        });
        bt.prompts.addPrompt(entry);
        pz.element = bt;
        row.pane.appendChild(bt);
        return row.pane;
    }
}

/** Report the box's current size to the machine as a `user_resize`
 *  interaction. Deferred to a microtask so whatever synchronous listeners the
 *  triggering event has (including Cell's initial pty fit) run first and the
 *  terminal reports its final grid. */
function reportResize(ifc: Interface, eb: EchoBox, entry: Entry): void {
    queueMicrotask(() => {
        const view = eb.getView("pty")?.childNodes[0] as EmbeddedTerm | undefined;
        const term = view?.terminal;
        ifc.interactions.push({
            type: "user_resize",
            pixel: eb.cellSize,
            pty: term ? { height: term.rows, width: term.cols } : undefined,
            entry,
        });
    });
}

export class PromptZone extends Zone {
    declare element: BucheTerm;
    echoMap: Map<Entry, EchoBox> = new Map();

    installEcho(ifc: Interface, entry: Entry): HTMLElement {
        const eb = new EchoBox();
        eb.bindEntry(entry);
        eb.addEventListener("close", () => {
            eb.destroyWhenDone = true;
            const code = eb.status === "unresponsive" ? 9 : 15;
            ifc.interactions.push({
                type: "user_signal",
                code,
                entry,
            });
        });
        eb.addEventListener("resize", () => reportResize(ifc, eb, entry));
        // Keyboard input bubbles up from the embedded terminal (see EmbeddedTerm).
        eb.addEventListener("term-data", (e) => {
            ifc.interactions.push({
                type: "user_text",
                text: (e as CustomEvent<string>).detail,
                entry,
            });
        });
        // The embedded terminal appearing is the first moment a pty grid
        // exists to report: announce the size then.
        eb.addEventListener("term-appear", () => reportResize(ifc, eb, entry));
        this.element.log(eb);
        this.echoMap.set(entry, eb);
        return eb;
    }

    installCell(ifc: Interface, entry: Entry): HTMLElement {
        let eb = this.echoMap.get(entry);
        if (!eb?.isConnected) {
            eb = this.installEcho(ifc, entry) as EchoBox;
            this.echoMap.set(entry, eb);
        }
        entry.fire();
        return eb;
    }

    installPrompt(ifc: Interface, entry: Entry): HTMLElement {
        const pz = entry.prompt!.zones.main;
        const bt = this.element!;
        bt.prompts.addPrompt(entry);
        pz.element = bt;
        return bt;
    }
}
