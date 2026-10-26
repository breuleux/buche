// The layout: carreau's workspace, holding buche's cells and prompts.
//
// Every cell is a carreau tab whose content is an <echo-box>; every prompt is
// a tab holding a prompt-column (a scroll stream of cells, with the prompt at
// its bottom). The core decides where things go (a Target: see types.ts);
// here, that becomes carreau placements. What processes do (new cells, cells
// that end) are host changes: undo, which is for the user's own layout
// changes, never reverts them, and closing is never undone.

import "carreau/src/prompt-view";
import { type Complex, complexAt } from "carreau/src/complex";
import type { Lifecycle } from "carreau/src/kinds";
import {
    find,
    findTab,
    genId,
    kind,
    panes,
    scrollColumn,
    scrollRow,
    slot,
} from "carreau/src/model";
import {
    configurePrompts,
    type PromptColumnNode,
    promptColumn,
    speakerOf,
} from "carreau/src/prompt";
import type { LayoutNode, PaneNode, Tab, WorkspaceData } from "carreau/src/types";
import { View } from "carreau/src/view";
import { Workspace } from "carreau/src/workspace";
import { defaultTheme } from "./color.ts";
import "./components/echo-box.tsx"; // (registers <echo-box>)
import type { EchoBox } from "./components/echo-box.tsx";
import type { PromptCollection } from "./components/prompt-collection.tsx";
import { SlotChooser } from "./components/slot-chooser.ts";
import { buildIcon, buildStyledText } from "./components/utils.tsx";
import type { StatusString } from "./echo.ts";
import { type Entry, statusOf } from "./entry.ts";
import type { Address, StyledText, Target } from "./types.ts";

/** What the layout needs from the interface. */
export interface LayoutHost {
    /** The entry at an address (to resolve anchors). */
    entryAt(address: Address): Entry | null;
    /** Make the box showing a cell (bound to its entry, events wired). */
    makeBox(entry: Entry): EchoBox;
    /** Make the prompt editor of a prompt-column (events wired). */
    makeEditor(): PromptCollection;
    /** Give the keyboard focus to an element (a box, a prompt row). */
    focus(el: HTMLElement): void;
    /** Signal an entry's process (15: terminate, 9: kill). */
    signal(entry: Entry, code: number): void;
    /** The keyboard focus fell off (to the page's body): put it back. */
    refocus(): void;
    /** The prompt the user typed in last (else any), to run commands from. */
    lastPrompt(): Entry | null;
    /** Run a command from a prompt, its cells going to `zone` (a slot's). */
    run(prompt: Entry, text: string, zone: string): void;
    /** Start a shell of its own (no prompt to run it from), its prompt in `zone`. */
    spawn(command: string, zone: string): void;
}

/**
 * A slot: where a choice (see SlotChooser) goes. A new tab (a chooser, until
 * it is replaced), or an empty pane (it goes into its tabs).
 */
type Slot = { tabId: string } | { paneId: string };

export interface LayoutOptions {
    /** Seconds a standby cell may stay scrolled out of view before it is killed. */
    standbyTimeout?: number;
}

/** Zones relative to the anchor: into the neighbour pane on that side. */
const DIRECTIONS = new Set(["left", "right", "up", "down"]);
/** What a pane can't be named: the reserved zones (see Target). */
const RESERVED = ["left", "right", "up", "down", "l", "r", "u", "d", "tab", "inline"];

/** The default layout: one pane, named "main", where the first prompt goes. */
export function defaultLayout(): WorkspaceData {
    return {
        root: { type: "pane", id: genId("p"), weight: 1, tabs: [], active: 0, name: "main" },
        floating: [],
    };
}

function resolveColor(value: string): string {
    try {
        return defaultTheme.calculateColor(value);
    } catch {
        return value;
    }
}

function tabStatus(entry: Entry): StatusString {
    const status = statusOf(entry).status;
    return status === "absent" ? "running" : status;
}

const escapeHtml = (s: string): string =>
    s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const ADJECTIVES = [
    "amber",
    "brisk",
    "calm",
    "dusky",
    "eager",
    "fuzzy",
    "gentle",
    "hazy",
    "icy",
    "jolly",
    "keen",
    "lucid",
    "mellow",
    "nimble",
    "olive",
    "plucky",
    "quiet",
    "rusty",
    "sunny",
    "tidy",
    "vivid",
    "witty",
];
const NOUNS = [
    "badger",
    "comet",
    "delta",
    "ember",
    "falcon",
    "grove",
    "harbor",
    "island",
    "lantern",
    "meadow",
    "nebula",
    "otter",
    "pebble",
    "quartz",
    "river",
    "sparrow",
    "thicket",
    "willow",
    "yarrow",
    "zephyr",
];

/** A name, quickly: two words at random. */
function randomName(): string {
    const pick = (words: string[]) => words[Math.floor(Math.random() * words.length)];
    return `${pick(ADJECTIVES)}-${pick(NOUNS)}`;
}

/** A new tab, offering what can go in it (see Layout.chooser). */
function chooserTab(): Tab {
    return { id: genId("t"), title: "New", short: "New", data: { chooser: true } };
}

/** What a tab shows of an entry: its label, command and status. */
function tabMeta(
    entry: Entry,
): Pick<Tab, "title" | "icon" | "short" | "long" | "accent" | "status"> {
    const echo = entry.echo;
    const { content, context } = echo.submission ?? {};
    const line = (cls: string, text: StyledText | undefined) =>
        text?.text
            ? `<div class="${cls}">${buildStyledText(text, defaultTheme).outerHTML}</div>`
            : "";
    const long = line("buche-long-context", context) + line("buche-long-command", content);
    return {
        title: echo.label.text,
        icon: echo.icon ? buildIcon(echo.icon).outerHTML : undefined,
        short: buildStyledText(echo.label, defaultTheme).outerHTML,
        long: long || undefined,
        accent: echo.color ? resolveColor(echo.color) : undefined,
        status: tabStatus(entry),
    };
}

export class Layout {
    readonly ws: Workspace;
    readonly view: View;
    /** Tab id by entry, and back. */
    private tabs = new Map<Entry, string>();
    private entries = new Map<string, Entry>();
    /** Each cell's box, by tab id (carreau keeps it across renders). */
    private boxes = new Map<string, EchoBox>();
    /** Each prompt-column's editor, by prompt node id. */
    private editors = new Map<string, PromptCollection>();
    /** Standby cells: seconds spent scrolled out of view, by tab id. */
    private parked = new Map<string, number>();
    private standbyTimeout: number;

    constructor(
        private host: LayoutHost,
        element: HTMLElement,
        data: WorkspaceData = defaultLayout(),
        options: LayoutOptions = {},
    ) {
        this.standbyTimeout = options.standbyTimeout ?? 30;
        this.ws = new Workspace(data.root);
        this.ws.load(data);
        this.ws.undoableClose = false;
        this.ws.reservedNames = RESERVED;
        this.ws.lifecycle = this.lifecycle();
        configurePrompts(this.ws, {
            // What's typed goes to the driver (see makeEditor): the cells it
            // makes come back through the core.
            submit: () => null,
            editor: (ctx) => this.editor(ctx.promptId),
        });
        this.view = new View(this.ws, element, {
            renderTab: (tab) =>
                this.boxes.get(tab.id) ??
                (tab.data?.chooser
                    ? this.chooser({ tabId: tab.id })
                    : document.createElement("div")),
            renderEmpty: (pane) => {
                const el = this.chooser({ paneId: pane.id });
                // Before the first prompt, the pane is likely to get it: show
                // its options only if it doesn't, a moment later (no flash).
                el.toggleAttribute("delayed", !this.prompted);
                return el;
            },
        });
        this.element = element;
        // (After the view's own listener: what is placed where is rendered.)
        this.ws.onChange(() => {
            // (Once the change is over: a tab can be in no tree for a moment,
            // in the middle of one, without being closed.)
            if (!this.forgetting) {
                this.forgetting = true;
                queueMicrotask(() => {
                    this.forgetting = false;
                    this.forgetClosed();
                });
            }
            // A render that moves what had the focus can drop it.
            requestAnimationFrame(() => {
                if (
                    document.activeElement === document.body &&
                    !this.element.querySelector(".nav-mode")
                ) {
                    this.host.refocus();
                }
            });
            this.syncFills();
            for (const box of this.boxes.values()) {
                if (box.isConnected) {
                    this.matchBackground(box);
                }
            }
        });
        // A stream cell given a height of its own (dragging its bar) has its
        // box fill it, as it goes: the drag changes the cell's classes, not
        // the layout (that's at its end).
        new MutationObserver((records) => {
            if (
                records.some((r) =>
                    (r.target as Element).classList?.contains("carreau-scrollcell"),
                )
            ) {
                this.syncFills();
            }
        }).observe(element, { attributes: true, attributeFilter: ["class"], subtree: true });
        setInterval(() => this.checkStandby(), 1000);
    }

    /**
     * Give a box's terminal the background of where the box sits (the first
     * one painted behind it: its pane's, its stream's), as `--cell-bg`.
     */
    private matchBackground(box: EchoBox): void {
        let bg = "";
        for (let el = box.parentElement; el && !bg; el = el.parentElement) {
            const c = getComputedStyle(el).backgroundColor;
            if (c && c !== "transparent" && c !== "rgba(0, 0, 0, 0)") {
                bg = c;
            }
        }
        if (bg && box.style.getPropertyValue("--cell-bg") !== bg) {
            box.style.setProperty("--cell-bg", bg);
            for (const term of box.querySelectorAll("embedded-term")) {
                (term as HTMLElement & { refreshBackground?(): void }).refreshBackground?.();
            }
        }
    }

    /**
     * Whether a box is its pane's whole content (then it fills it): not a cell
     * in a scroll stream, unless that cell is maximized (it takes the whole
     * area then).
     */
    private fills(box: EchoBox, maximized: boolean): boolean {
        if (!box.closest(".carreau-scroll") || box.closest(".carreau-cell-sized")) {
            return true;
        }
        return maximized && !!box.closest(".carreau-scrollcell")?.classList.contains("max-path");
    }

    /** Bring the boxes' `fills` up to date (see `fills`). */
    private syncFills(): void {
        const maximized = !!this.ws.maximized;
        for (const box of this.boxes.values()) {
            if (box.isConnected) {
                box.toggleAttribute("fills", this.fills(box, maximized));
            }
        }
    }

    // ── Focus ────────────────────────────────────────────────────────────────
    // Carreau's selection says which cell has the focus (and where it goes
    // when that cell closes: see `focusAfterClose`); the keyboard focus
    // follows it into the cell (the host's `focus`, e.g. into its terminal).

    private element: HTMLElement;

    /** Select the cell (or prompt) an element is in, as carreau sees it. */
    follow(el: Element): void {
        // (A render moving a focused element re-focuses it: not the user's doing.)
        if (this.view.rendering) {
            return;
        }
        for (
            let x = el.closest<HTMLElement>("[data-id]");
            x;
            x = x.parentElement?.closest<HTMLElement>("[data-id]") ?? null
        ) {
            const n = this.ws.node(x.dataset.id!);
            if (n && (n.type === "pane" || n.type === "prompt")) {
                if (this.ws.selection.id !== n.id) {
                    this.ws.select({ id: n.id });
                }
                return;
            }
        }
    }

    /**
     * Give the keyboard focus to the selected cell (e.g. when the one that had
     * it closed: carreau moved the selection where it belongs). Returns
     * whether there is one to take it.
     */
    commitFocus(): boolean {
        if (this.element.querySelector(".nav-mode")) {
            return true; // (leaving navigation mode will)
        }
        const before = document.activeElement;
        this.view.commitFocus();
        return document.activeElement !== before || this.ws.node(this.ws.selection.id) !== null;
    }

    // ── Entries ──────────────────────────────────────────────────────────────

    /** The entry a tab shows, if any. */
    entryOf(tabId: string): Entry | null {
        return this.entries.get(tabId) ?? null;
    }

    /** Whether the entry is shown. */
    has(entry: Entry): boolean {
        return this.tabs.has(entry);
    }

    /** The box showing a cell entry. */
    boxOf(entry: Entry): EchoBox | null {
        const id = this.tabs.get(entry);
        return (id && this.boxes.get(id)) || null;
    }

    /** Show a new cell where `target` says. */
    installCell(entry: Entry, target: Target): EchoBox {
        const tab: Tab = { id: genId("t"), ...tabMeta(entry) };
        const box = this.host.makeBox(entry);
        this.boxes.set(tab.id, box);
        this.bind(entry, tab.id);
        this.place(entry, target, tab);
        return box;
    }

    /** Whether a prompt was shown yet (see the chooser of empty panes). */
    private prompted = false;

    /** Show a new prompt where `target` says (a prompt-column in a new tab). */
    installPrompt(entry: Entry, target: Target): void {
        this.prompted = true;
        const tab = this.promptTab(entry);
        this.bind(entry, tab.id);
        this.place(entry, target, tab);
    }

    /**
     * A placeholder that a prompt claimed: its tab now holds a prompt-column,
     * in the same place.
     */
    convertToPrompt(entry: Entry): void {
        const old = this.tabs.get(entry);
        if (!old) {
            return;
        }
        const tab = this.promptTab(entry);
        this.boxes.get(old)?.unbindEntry();
        this.unbind(entry);
        this.bind(entry, tab.id);
        this.ws.hostChange((forest) => {
            const ft = findTab(forest, old);
            if (!ft) {
                return false;
            }
            ft.pane.tabs[ft.index] = structuredClone(tab);
        });
    }

    /** Remove an entry's tab right away (an ephemeral cell that ended). */
    remove(entry: Entry): void {
        const id = this.tabs.get(entry);
        if (id) {
            void this.ws.closeTab(id);
        }
    }

    /** Prompts that ended, whose tab stays while cells still run in it. */
    private ended = new Set<Entry>();

    /**
     * A prompt's shell ended. Merged with others, its tab goes, and its cells
     * go to the stream it was merged with. Otherwise its tab goes once
     * nothing runs in its stream anymore: closing it would end what does.
     */
    promptEnded(entry: Entry): void {
        const id = this.tabs.get(entry);
        const ft = id && this.findTab(id);
        if (!ft) {
            return;
        }
        if (complexAt(ft.pane, ft.index).tabs.length > 1 || !this.runsIn(id)) {
            this.ended.delete(entry);
            void this.ws.closeTab(id);
        } else {
            this.ended.add(entry);
        }
    }

    /** Close the tabs of ended prompts in which nothing runs anymore. */
    sweepEndedPrompts(): void {
        for (const entry of this.ended) {
            this.promptEnded(entry);
        }
    }

    /** Whether a cell in a prompt tab's stream still runs. */
    private runsIn(tabId: string): boolean {
        const col = this.columnOf(tabId);
        return (
            !!col &&
            panes(col).some((p) =>
                p.tabs.some((t) => {
                    const e = this.entries.get(t.id);
                    return !!e && !e.prompt && this.alive(e);
                }),
            )
        );
    }

    /** A live prompt shown, if any. */
    anyPrompt(): Entry | null {
        return [...this.tabs.keys()].find((e) => e.prompt && this.alive(e)) ?? null;
    }

    /** The prompt node of a prompt entry's column, if shown. */
    promptNodeOf(entry: Entry): string | null {
        const col = this.columnOf(this.tabs.get(entry) ?? "");
        return col?.children.at(-1)?.id ?? null;
    }

    /** The editor showing a prompt entry, and its element, if shown. */
    promptElement(entry: Entry): HTMLElement | null {
        for (const editor of this.editors.values()) {
            const el = editor.promptElement(entry);
            if (el?.isConnected && !el.hidden) {
                return el;
            }
        }
        return null;
    }

    /** Make a prompt the one shown in its stream (its tab active), and select it. */
    revealPrompt(entry: Entry): HTMLElement | null {
        const tabId = this.tabs.get(entry);
        const ft = tabId && this.findTab(tabId);
        if (!ft) {
            return null;
        }
        this.ws.activateTab(ft.pane.id, ft.index);
        const q = this.promptNodeOf(entry);
        if (q) {
            this.ws.select({ id: q });
        }
        return this.promptElement(entry);
    }

    private bind(entry: Entry, tabId: string): void {
        this.tabs.set(entry, tabId);
        this.entries.set(tabId, entry);
        const refresh = (): void => this.refresh(entry);
        entry.listeners.push(refresh);
        entry.representative()?.listeners.push(refresh);
    }

    private unbind(entry: Entry): void {
        const id = this.tabs.get(entry);
        if (id) {
            this.entries.delete(id);
            this.boxes.delete(id);
            this.parked.delete(id);
        }
        this.tabs.delete(entry);
    }

    /** Whether forgetting the tabs that closed is scheduled. */
    private forgetting = false;

    /** Forget the tabs that closed. */
    private forgetClosed(): void {
        const live = new Set<string>();
        for (const t of this.ws.trees()) {
            for (const p of panes(t)) {
                for (const tab of p.tabs) {
                    live.add(tab.id);
                }
            }
        }
        for (const [id, entry] of this.entries) {
            if (!live.has(id)) {
                this.boxes.get(id)?.unbindEntry();
                this.unbind(entry);
            }
        }
        for (const [zone, where] of this.slots) {
            if (!this.slotLive(where, live)) {
                this.slots.delete(zone);
            }
        }
    }

    /** Bring an entry's tab up to date (label, command, status). */
    private refresh(entry: Entry): void {
        const id = this.tabs.get(entry);
        const ft = id && this.findTab(id);
        if (!ft) {
            return;
        }
        const tab = ft.pane.tabs[ft.index] as unknown as Record<string, unknown>;
        const meta = tabMeta(entry) as Record<string, unknown>;
        // (Only when it changes: a render moves the editors, mid-typing.)
        if (Object.keys(meta).some((k) => tab[k] !== meta[k])) {
            Object.assign(tab, meta);
            this.ws.emit();
        }
    }

    private findTab(tabId: string): { pane: PaneNode; index: number } | null {
        for (const t of this.ws.trees()) {
            const ft = findTab(t, tabId);
            if (ft) {
                return ft;
            }
        }
        return null;
    }

    // ── Placing ──────────────────────────────────────────────────────────────

    private promptTab(entry: Entry): Tab {
        const col = promptColumn([]);
        col.weight = 1;
        return { id: genId("t"), ...tabMeta(entry), group: slot(col) };
    }

    /** The prompt-column a tab holds, if any. */
    private columnOf(tabId: string): PromptColumnNode | null {
        const ft = this.findTab(tabId);
        const root = ft?.pane.tabs[ft.index].group?.children[0];
        return root?.type === "prompt-column" ? (root as PromptColumnNode) : null;
    }

    /** The pane holding a node, out of any scroll stream it is in (the stream's own tab's). */
    private outerPane(id: string): PaneNode | null {
        const idx = this.ws.index();
        let n: LayoutNode | null = idx.node(id);
        for (;;) {
            const parent: LayoutNode | null = n && idx.parent(n.id);
            if (!n || !parent) {
                return n?.type === "pane" ? n : null;
            }
            if (n.type === "pane" && !kind(parent).scroll) {
                return n;
            }
            n = parent.type === "slot" ? idx.parent(parent.id) : parent;
        }
    }

    /** Where things go when nothing says: the pane named "main", or the first one. */
    private defaultPane(): PaneNode {
        return this.ws.paneByName("main") ?? panes(this.ws.root)[0];
    }

    private place(entry: Entry, target: Target, tab: Tab): void {
        // Into a slot the user picked it for (if it's still there).
        if (target.zone.startsWith("~")) {
            const where = this.slots.get(target.zone);
            if (where && this.slotLive(where)) {
                this.fill(target.zone, tab);
                return;
            }
            target = { ...target, zone: "tab" };
        }
        const anchor = target.anchor && this.host.entryAt(target.anchor);
        const anchorTab = anchor ? this.tabs.get(anchor) : undefined;
        const at = anchorTab ? this.findTab(anchorTab) : null;
        const isPrompt = !!tab.group;
        const pane = (p: PaneNode | null) => p ?? this.defaultPane();
        const newPane = (): PaneNode => ({
            type: "pane",
            id: genId("p"),
            weight: 1,
            tabs: [tab],
            active: 0,
        });
        const into = (p: PaneNode, index = p.tabs.length) =>
            this.ws.hostDrop(
                { kind: "external", node: newPane() },
                { kind: "tab", paneId: p.id, index },
            );

        if (target.zone === "inline" && !isPrompt && at) {
            // Into the stream the anchor is in (its own, for a prompt).
            const col = this.columnOf(anchorTab!);
            if (col) {
                this.inColumn(col, anchorTab!, newPane());
                return;
            }
            if (kind(this.ws.index().parent(at.pane.id) ?? at.pane).scroll) {
                this.ws.hostDrop(
                    { kind: "external", node: newPane() },
                    { kind: "side", targetId: at.pane.id, side: "bottom" },
                );
                return;
            }
        }
        if (target.zone === "inline" || target.zone === "tab") {
            // A prompt goes out of scroll streams: beside the stream's own tab.
            const stream = isPrompt && anchorTab ? this.streamOf(anchorTab) : null;
            const beside = stream ? this.findTab(stream) : at;
            const dest = pane(beside?.pane ?? null);
            const after = beside ? this.afterComplex(beside.pane, beside.index) : dest.tabs.length;
            const before = dest.tabs[dest.active]?.id;
            const ok = into(dest, after);
            if (ok && isPrompt && target.link && stream && this.columnOf(stream)) {
                this.link(tab.id, stream);
            }
            // What was shown stays shown for a background cell, and beside a
            // process's first view (its later outputs), unless it is its GUI.
            const later =
                !isPrompt && !!at && !this.columnOf(anchorTab!) && entry.field !== "$gui";
            const keep = (entry.echo.background || later) && before;
            const show = ok && this.findTab(keep ? before : tab.id);
            if (show) {
                this.ws.activateTab(show.pane.id, show.index);
            }
            return;
        }
        if (DIRECTIONS.has(target.zone)) {
            // Into the neighbour pane's tabs (not into a stream it shows);
            // with none on that side, a new pane there.
            const base = pane(at ? this.outerPane(at.pane.id) : null);
            const dir = target.zone as "left" | "right" | "up" | "down";
            const next = this.ws.cellAt(base.id, dir);
            const dest = next ? this.outerPane(next) : null;
            if (dest) {
                into(dest);
            } else {
                this.ws.hostPlace(
                    { split: "tab", base: [{ id: base.id }, dir], force: true, focus: false },
                    tab,
                );
            }
            return;
        }
        // A named pane; made (on the right) if there is none yet.
        const named = this.ws.paneByName(target.zone);
        if (named) {
            into(named);
            return;
        }
        const id = this.ws.hostDrop(
            { kind: "external", node: { ...newPane(), name: target.zone } },
            { kind: "side", targetId: this.ws.root.id, side: "right" },
        );
        if (id === null) {
            into(this.defaultPane());
        }
    }

    /**
     * The tab whose stream a tab is in (a cell in a prompt-column: the tab
     * holding the column), or that holds one itself; else the tab of the
     * pane it is in, out of scroll streams.
     */
    private streamOf(tabId: string): string | null {
        if (this.columnOf(tabId)) {
            return tabId;
        }
        const ft = this.findTab(tabId);
        const outer = ft && this.outerPane(ft.pane.id);
        if (!ft || !outer) {
            return null;
        }
        if (outer === ft.pane) {
            return tabId;
        }
        const idx = this.ws.index();
        for (const t of outer.tabs) {
            const root = t.group?.children[0];
            if (root && find(root, ft.pane.id) && idx.node(root.id)) {
                return t.id;
            }
        }
        return null;
    }

    /** The tab holding the stream a tab's cells are shown in: its complex's first. */
    private streamTab(tabId: string): string {
        const ft = this.findTab(tabId);
        return ft ? complexAt(ft.pane, ft.index).tabs[0].id : tabId;
    }

    /** Past the end of the complex at `index` (so as not to break it). */
    private afterComplex(pane: PaneNode, index: number): number {
        const c: Complex = complexAt(pane, index);
        return c.start + c.tabs.length;
    }

    /**
     * A new cell at the end of a prompt-column's stream: the one shown, if
     * merged, remembering which column it comes from.
     */
    private inColumn(col: PromptColumnNode, originTab: string, node: PaneNode): void {
        const shownCol = this.columnOf(this.streamTab(originTab)) ?? col;
        this.ws.hostChange((forest) => {
            const c = find(forest, shownCol.id)?.node as PromptColumnNode | undefined;
            if (c?.type !== "prompt-column") {
                return false;
            }
            const n = structuredClone(node);
            c.children.splice(c.children.length - 1, 0, n);
            (c.cells ??= {})[n.id] = { order: Date.now(), origin: originTab };
        });
    }

    /** Merge a new prompt's tab with the stream it was started from. */
    private link(tabId: string, withTab: string): void {
        this.ws.hostChange((forest) => {
            const a = findTab(forest, tabId);
            const b = findTab(forest, withTab);
            if (!a || !b || a.pane !== b.pane) {
                return false;
            }
            const linkId = b.pane.tabs[b.index].link ?? genId("l");
            b.pane.tabs[b.index].link = linkId;
            // (Adjacent to the complex: placed right after it.)
            a.pane.tabs[a.index].link = linkId;
        });
    }

    // ── Prompt editors ───────────────────────────────────────────────────────

    /**
     * A prompt-column's editor: a prompt collection showing whoever types
     * (merged columns: the complex's active member).
     */
    private editor(promptId: string) {
        const collection = this.host.makeEditor();
        this.editors.set(promptId, collection);
        return {
            el: collection,
            focus: () => {
                const speaker = speakerOf(this.ws, promptId);
                const entry = speaker && this.entries.get(speaker.id);
                // (The speaker's prompt may be gone already: its shell ended.)
                const shown =
                    (entry && collection.promptElement(entry)) || collection.activePrompt;
                const el =
                    shown instanceof HTMLElement
                        ? shown
                        : shown && collection.promptElement(shown);
                if (el) {
                    this.host.focus(el);
                }
            },
            update: ({ speaker }: { speaker: Tab | null }) => {
                const entry = speaker && this.entries.get(speaker.id);
                if (entry?.prompt && collection.activePrompt !== entry) {
                    collection.addPrompt(entry);
                    collection.showPrompt(entry, false);
                }
            },
            destroy: () => {
                this.editors.delete(promptId);
                for (const entry of collection.prompts) {
                    collection.removePrompt(entry);
                }
            },
        };
    }

    // ── Slots ────────────────────────────────────────────────────────────────
    // A new tab (insert) or an empty pane offers what can go there (see
    // SlotChooser). What runs a command from a prompt sends it with the slot's
    // zone ("~" and the tab's or pane's id): `place` puts what it shows there.

    /** Slots by zone. */
    private slots = new Map<string, Slot>();

    /** What a slot offers. */
    private chooser(where: Slot): HTMLElement {
        const zone = `~${"tabId" in where ? where.tabId : where.paneId}`;
        this.slots.set(zone, where);
        const el = new SlotChooser();
        // A new stream, empty, which stays when emptied: things go there later.
        const group = (name: string, make: typeof scrollColumn): Tab => {
            const stream = make([]);
            stream.keep = true;
            return { id: genId("t"), title: name, short: escapeHtml(name), group: slot(stream) };
        };
        // Named at random, the name being edited in its tab right away (like
        // renaming it: Enter keeps it, typing replaces it).
        const stream = (make: typeof scrollColumn) => {
            const tab = group(randomName(), make);
            this.fill(zone, tab);
            this.view.editTabTitle(tab.id);
        };
        el.setOptions([
            { label: "New scroll column", pick: () => stream(scrollColumn) },
            { label: "New scroll row", pick: () => stream(scrollRow) },
            {
                // From the last prompt (in its directory); with none, a shell
                // of its own (in the terminal's).
                label: "Shell (cq)",
                pick: () => {
                    const p = this.host.lastPrompt();
                    if (p) {
                        this.host.run(p, "cq", zone);
                    } else {
                        this.host.spawn("cq", zone);
                    }
                },
            },
        ]);
        el.setCommand("A command to run here (from the last prompt)", (text) => {
            const p = this.host.lastPrompt();
            if (p) {
                this.host.run(p, text, zone);
            } else {
                el.setMessage("No prompt to run it from.");
            }
        });
        el.oncancel = () => {
            if ("tabId" in where) {
                void this.ws.closeTab(where.tabId);
            } else {
                el.blur();
            }
        };
        return el;
    }

    /**
     * Insert a new tab (a slot, offering what goes in it), from the focused
     * cell: into its pane, or the pane on `dir`'s side (made if there is none)
     * — or, with `beside`, in a new pane on that side. From a prompt, or a
     * cell in a stream: from the pane holding the stream. An undo step, like
     * any of the user's layout changes.
     */
    insert(dir?: "left" | "right" | "up" | "down", beside = false): void {
        const ws = this.ws;
        const sel = ws.node(ws.selection.id);
        const base =
            sel &&
            this.outerPane(
                sel.type === "pane" || sel.type === "prompt" ? sel.id : ws.descend(sel),
            );
        if (!base) {
            return;
        }
        const tab = chooserTab();
        const side = ({ left: "left", right: "right", up: "top", down: "bottom" } as const)[
            dir ?? "right"
        ];
        // (Beside: a new pane. Else into a pane: this one, or the neighbour's.)
        const next = dir && !beside ? ws.cellAt(base.id, dir) : null;
        const dest = beside ? null : !dir ? base : next ? this.outerPane(next) : null;
        if (dest) {
            const node: PaneNode = {
                type: "pane",
                id: genId("p"),
                weight: 1,
                tabs: [tab],
                active: 0,
            };
            const r = ws.tryDrop(
                { kind: "external", node },
                { kind: "tab", paneId: dest.id, index: dest.tabs.length },
            );
            if (r) {
                ws.commitDrop(r);
            }
        } else {
            ws.place({ split: side, base: { id: base.id } }, tab);
        }
    }

    /** Whether a slot is still there (its tab, or its pane). */
    private slotLive(where: Slot, live?: Set<string>): boolean {
        if ("tabId" in where) {
            return live ? live.has(where.tabId) : !!this.findTab(where.tabId);
        }
        return this.ws.node(where.paneId)?.type === "pane";
    }

    /**
     * Put a tab in a slot: in place of its chooser tab, or into its pane. The
     * focus goes there, into the chooser of a new stream if it is one.
     */
    private fill(zone: string, tab: Tab): void {
        const where = this.slots.get(zone);
        if (!where) {
            return;
        }
        this.slots.delete(zone);
        const ok = this.ws.hostChange((forest) => {
            const t = structuredClone(tab);
            if ("tabId" in where) {
                const ft = findTab(forest, where.tabId);
                if (!ft) {
                    return false;
                }
                ft.pane.tabs[ft.index] = t;
            } else {
                const p = find(forest, where.paneId)?.node;
                if (p?.type !== "pane") {
                    return false;
                }
                p.tabs.push(t);
                p.active = p.tabs.length - 1;
            }
        });
        const inner = tab.group && panes(tab.group)[0];
        if (ok && inner) {
            this.ws.select({ id: inner.id });
            this.view.commitFocus();
        }
    }

    // ── Closing ──────────────────────────────────────────────────────────────

    private lifecycle(): Lifecycle {
        return {
            closeTab: (tab) => this.close(tab),
            forceCloseTab: async (tab) => {
                const entry = this.entries.get(tab.id);
                if (entry && this.alive(entry)) {
                    this.host.signal(entry, 9);
                }
            },
            commitFocus: (tab, content) => {
                // (`content` is carreau's wrapper around what renderTab gave,
                // the box: the box is the one to ask.)
                const box = this.boxes.get(tab.id);
                const chooser = content?.querySelector("slot-chooser");
                if (box?.isConnected) {
                    this.host.focus(box);
                } else if (chooser instanceof HTMLElement) {
                    chooser.focus({ preventScroll: true });
                }
            },
            // A new tab (insert, Alt+Q I): what goes in it, the user chooses.
            spawn: () => chooserTab(),
        };
    }

    private alive(entry: Entry): boolean {
        const status = statusOf(entry).status;
        return status !== "done" && status !== "error";
    }

    /**
     * Closing a tab ends its process: terminated (killed, if it doesn't
     * answer anymore), and closed once it has ended. Unless another tab still
     * shows that process (its terminal, beside its GUI): that one stays, and
     * the process with it.
     */
    private close(tab: Tab): Promise<void> {
        const entry = this.entries.get(tab.id);
        if (!entry || !this.alive(entry)) {
            return Promise.resolve();
        }
        const process = entry.representative() ?? entry;
        const others = [...this.tabs.keys()].some(
            (e) => e !== entry && (e.representative() ?? e) === process && this.alive(e),
        );
        if (others) {
            return Promise.resolve();
        }
        const unresponsive = statusOf(entry).status === "unresponsive";
        this.host.signal(entry, unresponsive ? 9 : 15);
        if (unresponsive) {
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            const check = (): void => {
                if (!this.alive(entry)) {
                    process.listeners = process.listeners.filter((l) => l !== check);
                    resolve();
                }
            };
            process.listeners.push(check);
        });
    }

    // ── Standby ──────────────────────────────────────────────────────────────

    /**
     * Standby cells are temporary interfaces: one that stays scrolled out of
     * view (out of sight even with its stream scrolled to the bottom) for
     * `standbyTimeout` seconds in a row is closed, which kills it. The count
     * pauses while its stream isn't shown at all (another tab, a hidden
     * window): the user can't have looked at it then.
     */
    private checkStandby(): void {
        for (const [id, box] of this.boxes) {
            const entry = this.entries.get(id);
            if (!entry || statusOf(entry).status !== "standby") {
                this.parked.delete(id);
                continue;
            }
            const scroller = box.closest<HTMLElement>(".carreau-scroll");
            if (!scroller) {
                this.parked.delete(id);
                continue;
            }
            const shown =
                typeof document !== "undefined" &&
                !document.hidden &&
                (typeof scroller.checkVisibility !== "function" || scroller.checkVisibility());
            if (!shown) {
                continue;
            }
            const cell = box.getBoundingClientRect();
            const view = scroller.getBoundingClientRect();
            const visible = cell.bottom > view.top && cell.top < view.bottom;
            const bottom = cell.bottom - view.top + scroller.scrollTop;
            const outOfReach = scroller.scrollHeight - bottom > scroller.clientHeight;
            if (visible || !outOfReach) {
                this.parked.set(id, 0);
                continue;
            }
            const seconds = (this.parked.get(id) ?? 0) + 1;
            this.parked.set(id, seconds);
            if (seconds >= this.standbyTimeout) {
                this.parked.delete(id);
                void this.ws.closeTab(id);
            }
        }
    }
}
