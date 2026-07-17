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
import { statusOf } from "./entry.ts";
import type { FocusChangeDetail } from "./focus.ts";
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

/** Behave like a box's ✕. An alive cell gets SIGTERM and removes itself once
 *  the confirmation (done/error) arrives; an already unresponsive one gets
 *  SIGKILL and goes away immediately — a stalled process is not expected to
 *  confirm anything. A spent one (done/error) is not signaled at all: there is
 *  no process to kill, and a signal would mark the entry unresponsive —
 *  poisoning the other boxes showing the same entry (e.g. the prompt-zone
 *  echo of a cell closed from its tab) with a change that never happened. */
function closeBox(ifc: Interface, eb: EchoBox, entry: Entry): void {
    if (eb.status === "done" || eb.status === "error") {
        eb.destroy();
        return;
    }
    const code = eb.status === "unresponsive" ? 9 : 15;
    ifc.interactions.push({ type: "user_signal", code, entry });
    if (code === 9) {
        eb.destroy();
    } else {
        eb.destroyWhenDone = true;
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
        eb.addEventListener("close", () => closeBox(ifc, eb, entry));
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
        // has ended after a close; the tab goes with it. The "destroy" listener
        // also catches boxes removed without any entry change following (a
        // spent cell closed by ✕ or C-q-d).
        const check = this.removeTabWhen(entry, () => !eb.isConnected);
        eb.addEventListener("destroy", check);
        this.closers.set(entry, () =>
            eb.dispatchEvent(new CustomEvent<null>("close", { bubbles: true })),
        );
        // A new tab stays in the background, unless it holds the cell the
        // focus is waiting for (not a background one: see the interface).
        if (eb.id && ifc.focus.expecting === eb.id) {
            this.element.showTab(entry);
        }
        return eb;
    }

    installPrompt(ifc: Interface, entry: Entry): HTMLElement {
        const row = this.element.addTab(entry);
        // The tab's ✕ signals the prompt's process, like a cell's ✕ (through
        // `represents` when the prompt stands for one).
        this.closers.set(entry, () => {
            const code = statusOf(entry).status === "unresponsive" ? 9 : 15;
            ifc.interactions.push({ type: "user_signal", code, entry });
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
        // The tab goes when the process has ended — but only once the
        // BucheTerm holds no live prompt at all: nested shells install into
        // this same collection, and pulling the tab while one drains would
        // take it down with the outer prompt (visually, at least).
        const check = this.removeTabWhen(entry, () =>
            bt.prompts.prompts.every((prompt) => {
                const status = statusOf(prompt).status;
                return status === "done" || status === "error";
            }),
        );
        // A nested prompt's removal never touches the outer entry's
        // listeners; the collection itself must re-trigger the check.
        bt.prompts.addEventListener("promptremoved", check);
        pz.element = bt;
        attachPopZone(entry.prompt!.zones.pop, bt, entry);
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

/** Give a prompt's PopZone its float slot in the <buche-term> hosting the
 *  prompt (the per-row slot above the prompt row, see prompt-collection). The
 *  first slot a prompt gets is its own (re-installs don't move the pop). */
function attachPopZone(pop: PopZone, bt: BucheTerm, entry: Entry): void {
    const slot = bt.prompts.popElement(entry);
    if (slot && !pop.element) {
        pop.element = slot;
        pop.promptRow = bt.prompts.promptElement(entry);
    }
}

export class PromptZone extends Zone {
    declare element: BucheTerm;

    installCell(ifc: Interface, entry: Entry): HTMLElement {
        const eb = new EchoBox();
        eb.bindEntry(entry);
        eb.addEventListener("close", () => closeBox(ifc, eb, entry));
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
        eb.observePromptActivity(this.element.prompts);
        tagCell(eb, entry);
        entry.fire();
        return eb;
    }

    installPrompt(ifc: Interface, entry: Entry): HTMLElement {
        const pz = entry.prompt!.zones.main;
        const bt = this.element!;
        bt.prompts.addPrompt(entry);
        pz.element = bt;
        attachPopZone(entry.prompt!.zones.pop, bt, entry);
        return bt;
    }

    revealPrompt(entry: Entry): HTMLElement | null {
        this.element.prompts.showPrompt(entry, false);
        return this.element.prompts.promptElement(entry);
    }
}

/**
 * A floating zone pinned right above its prompt's row (its element is the
 * prompt's float slot in the <prompt-collection>, wired at prompt install). It
 * holds a single cell, shown as a compact echo box floating over the rest of
 * the interface:
 *   * installing a cell closes (signals, like ✕) whatever the pop held before;
 *   * the box's own ✕ closes it the same way;
 *   * whenever the focus *explicitly* leaves the cell, the pop closes and the
 *     float disappears (the slot hides itself when empty);
 *   * unlike other cells, the end of the process (done/error) does not shift
 *     the focus on its own — the pop holds it until it is moved (Esc brings
 *     it back to the prompt once the process is spent).
 */
export class PopZone extends Zone {
    declare element: HTMLElement;
    /** The prompt row this pop floats above (set with the slot by
     *  attachPopZone); Esc on a spent cell sends the focus back to it. */
    promptRow: HTMLElement | null = null;
    private current: EchoBox | null = null;
    // What closing the current cell does (signal + removal); null when empty.
    private closer: (() => void) | null = null;
    // The focus manager's root, while a cell is open (see onFocusChange).
    private watched: HTMLElement | null = null;
    // The interface the current cell was installed through (Esc refocuses via
    // its focus manager); cleared when the pop closes.
    private ifc: Interface | null = null;

    installCell(ifc: Interface, entry: Entry): HTMLElement {
        // One cell at a time: the previous pop closes before the new one shows.
        this.dismiss();
        this.ifc = ifc;
        const eb = new EchoBox();
        eb.setCompact(true);
        eb.bindEntry(entry);
        this.closer = () => {
            // Spent cells are not signaled (see closeBox): the other views of
            // the entry would hear about a kill that never happened.
            if (eb.status !== "done" && eb.status !== "error") {
                const code = eb.status === "unresponsive" ? 9 : 15;
                ifc.interactions.push({ type: "user_signal", code, entry });
            }
            eb.remove();
        };
        eb.addEventListener("close", () => this.dismiss());
        eb.addEventListener("resize", () => reportResize(ifc, eb, entry));
        // Keyboard input bubbles up from the embedded terminal (see EmbeddedTerm).
        eb.addEventListener("term-data", (e) => {
            ifc.interactions.push({
                type: "user_text",
                text: (e as CustomEvent<string>).detail,
                entry,
            });
        });
        eb.addEventListener("term-appear", () => reportResize(ifc, eb, entry));
        // A pop cell ends without shifting the focus on its own (the interface
        // releases ended cells unless sticky, see releaseEndedCell): it holds
        // the focus until it is moved explicitly.
        entry.echo.sticky = true;
        this.element.append(eb);
        this.current = eb;
        tagCell(eb, entry);
        // Focus leaving the cell closes the pop. "focus-change" is dispatched
        // on the focus manager's root (see focus.ts) and bubbles *up* from
        // there, so the listener goes on the root itself, not on the slot.
        // Esc rides on the same root: in *capture*, so it is seen before
        // xterm's textarea handler can turn it into pty input.
        this.watched = ifc.focus.root;
        this.watched.addEventListener("focus-change", this.onFocusChange);
        this.watched.addEventListener("keydown", this.onKeyDown, true);
        return eb;
    }

    // Esc on a spent pop (done or error) brings the focus back to the prompt —
    // which, the focus having moved, also closes the pop. While the process
    // runs, Escape belongs to the app and passes through.
    private onKeyDown = (event: Event): void => {
        const key = event as KeyboardEvent;
        const pop = this.current;
        if (key.key !== "Escape" || !pop?.isConnected || !pop.contains(key.target as Node)) {
            return;
        }
        if (pop.status !== "done" && pop.status !== "error") {
            return;
        }
        const ifc = this.ifc;
        if (!ifc) {
            return;
        }
        key.preventDefault();
        key.stopPropagation();
        const row = this.promptRow;
        if (row) {
            ifc.focus.focus(row, "nav");
            if (!ifc.focus.holdCommits) {
                ifc.focus.commitFocus();
            }
        } else {
            ifc.focusPrompt();
        }
    };

    private onFocusChange = (event: Event): void => {
        const pop = this.current;
        if (!pop?.isConnected) {
            return;
        }
        const { previous, current } = (event as CustomEvent<FocusChangeDetail>).detail;
        const wasIn = previous !== null && (previous === pop || pop.contains(previous));
        const nowIn = current !== null && (current === pop || pop.contains(current));
        if (wasIn && !nowIn) {
            this.dismiss();
        }
    };

    /** Close the current cell, if any (signal it, like its ✕, and unfloat). */
    private dismiss(): void {
        const closer = this.closer;
        this.closer = null;
        this.current = null;
        this.watched?.removeEventListener("focus-change", this.onFocusChange);
        this.watched?.removeEventListener("keydown", this.onKeyDown, true);
        this.watched = null;
        this.ifc = null;
        closer?.();
    }
}
