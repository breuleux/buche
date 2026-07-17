import { BucheTerm } from "./components/buche-term.tsx";
import { EchoBox } from "./components/echo-box.tsx";
import type { EmbeddedTerm } from "./components/embedded-term.tsx";
import type {
    PromptCommandEvent,
    PromptTextChangeEvent,
} from "./components/prompt-collection.tsx";
import type { TabCloseEvent, TabPane } from "./components/tab-pane.tsx";
import { echoElementId } from "./echo.ts";
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

    /** Make a prompt installed here the visible one (switching tabs, etc.)
     *  without focusing it; returns its element, or null. */
    revealPrompt(entry: Entry): HTMLElement | null {
        return null;
    }
}

/**
 * Give a cell's box the DOM id derived from its echo's command id, so that the
 * interface can expect it (see BucheInterface.pushCommand). Only the box that
 * hosts the cell gets it: an echo shown elsewhere (e.g. in a prompt's log,
 * while the cell went to a tab) is only a handle, and must not take the focus.
 */
function tagCell(eb: EchoBox, entry: Entry): void {
    if (entry.echo.id !== undefined) {
        eb.id = echoElementId(entry.echo.id);
    }
}

export class TabbedZone extends Zone {
    declare element: TabPane;
    // What each tab's ✕ does, by entry (see installCell / installPrompt).
    private closers = new Map<Entry, () => void>();

    constructor(args: ZoneConfiguration) {
        super(args);
        this.names.push("tab");
        this.element?.addEventListener("tabclose", (e: TabCloseEvent) => {
            this.closers.get(e.detail.entry)?.();
        });
    }

    // Remove an entry's tab once `gone()` says its content is gone, checked
    // now and whenever the entry changes.
    private removeTabWhen(entry: Entry, gone: () => boolean): () => void {
        const check = (): void => {
            if (gone()) {
                entry.listeners = entry.listeners.filter((l) => l !== check);
                this.closers.delete(entry);
                this.element.removeTab(entry);
            }
        };
        entry.listeners.push(check);
        return check;
    }

    installCell(ifc: Interface, entry: Entry): HTMLElement {
        const row = this.element.addTab(entry);
        const eb = new EchoBox();
        eb.setCompact(true);
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
        eb.addEventListener("term-data", (e) => {
            ifc.interactions.push({
                type: "user_text",
                text: (e as CustomEvent<string>).detail,
                entry,
            });
        });
        row.pane.appendChild(eb);
        tagCell(eb, entry);
        // The tab's ✕ is the cell's ✕. The box removes itself once its process
        // has ended after a close; the tab goes with it.
        const check = this.removeTabWhen(entry, () => !eb.isConnected);
        this.closers.set(entry, () => {
            eb.dispatchEvent(new CustomEvent<null>("close", { bubbles: true }));
            check();
        });
        // A new tab stays in the background, unless it holds the cell the
        // focus is waiting for (not a background one: see the interface).
        if (eb.id && ifc.focus.expecting === eb.id) {
            this.element.showTab(entry);
        }
        return eb;
    }

    installPrompt(ifc: Interface, entry: Entry): HTMLElement {
        const row = this.element.addTab(entry);
        // The tab's ✕ signals the prompt's process, like a cell's ✕; the tab
        // goes when the process has ended (the prompt is then removed).
        this.closers.set(entry, () => {
            const code = entry.echo.status.status === "unresponsive" ? 9 : 15;
            ifc.interactions.push({ type: "user_signal", code, entry });
        });
        this.removeTabWhen(entry, () => {
            const status = entry.echo.status.status;
            return status === "done" || status === "error";
        });
        const pz = entry.prompt!.zones.main;
        const bt = new BucheTerm();
        bt.prompts.addEventListener("command", (event: PromptCommandEvent) => {
            ifc.pushCommand(event.detail);
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

    revealPrompt(entry: Entry): HTMLElement | null {
        // INELEGANCE
        const bt = this.element.paneFor(entry)?.querySelector("buche-term") as BucheTerm | null;
        if (!bt) {
            return null;
        }
        this.element.showTab(entry);
        bt.prompts.showPrompt(entry, false);
        return bt.prompts.promptElement(entry);
    }
}

// The size last reported per box. The box's single polled "resize" event also
// fires once on reappear (so the terminal's fit can re-derive its grid) even
// when the size is unchanged, and the pty grid can settle after the fit
// without a pixel change — so an identical (pixel, pty) payload is announced
// on the wire only once.
const lastReported = new WeakMap<EchoBox, string>();

/** Report the box's current size to the machine as a `user_resize`
 *  interaction. Deferred to a microtask so whatever synchronous listeners the
 *  triggering event has (including Cell's initial pty fit) run first and the
 *  terminal reports its final grid. */
function reportResize(ifc: Interface, eb: EchoBox, entry: Entry): void {
    queueMicrotask(() => {
        const view = eb.getView("pty")?.childNodes[0] as EmbeddedTerm | undefined;
        const term = view?.terminal;
        const pixel = eb.cellSize;
        const pty = term ? { height: term.rows, width: term.cols } : undefined;
        const sig = `${pixel.height}x${pixel.width}/${pty ? `${pty.height}x${pty.width}` : "-"}`;
        if (lastReported.get(eb) === sig) {
            return;
        }
        lastReported.set(eb, sig);
        ifc.interactions.push({ type: "user_resize", pixel, pty, entry });
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
        tagCell(eb, entry);
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

    revealPrompt(entry: Entry): HTMLElement | null {
        this.element.prompts.showPrompt(entry, false);
        return this.element.prompts.promptElement(entry);
    }
}
