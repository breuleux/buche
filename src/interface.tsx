import { KeyboardNav, type NavConfig } from "carreau/src/keyboard";
import { panes } from "carreau/src/model";
import type { LayoutNode, WorkspaceData } from "carreau/src/types";
import { BucheGui, GUI_APPEAR_EVENT, GUI_SEND_EVENT } from "./components/buche-gui.tsx";
import { EchoBox } from "./components/echo-box.tsx";
import type { EmbeddedTerm } from "./components/embedded-term.tsx";
import {
    PromptCollection,
    type PromptCommandDetail,
    type PromptCommandEvent,
    type PromptTextChangeEvent,
} from "./components/prompt-collection.tsx";
import { refocusTitleEditor, showTitleEditor } from "./components/title-editor.ts";
import { showToast } from "./components/toast.ts";
import type { Buche } from "./core";
import { echoElementId, killable } from "./echo.ts";
import { type Entry, statusOf } from "./entry.ts";
import {
    type Direction,
    type FocusChangeDetail,
    FocusManager,
    type NavigationMode,
} from "./focus.ts";
import type { IncomingInterfaceMessage } from "./interface-exchange/incoming";
import type {
    CellCommandMessage,
    OutgoingInterfaceMessage,
    ProblemMessage,
    UpdateCellMessage,
    UpdateEntryMessage,
    UpdatePromptMessage,
} from "./interface-exchange/outgoing";
import { type KeyHandler, ModalKeys } from "./keybindings.ts";
import { Layout, type LayoutOptions } from "./layout.ts";
import type { Json } from "./types.ts";
import type { BucheErrorMessage } from "./utils";
import { AsyncQueue } from "./utils.ts";

export interface Interface {
    interactions: AsyncIterable<IncomingInterfaceMessage | BucheErrorMessage>;
    processMessage: (buche: Buche, message: OutgoingInterfaceMessage) => void;
}

export interface BucheInterfaceArguments extends LayoutOptions {
    container: HTMLElement;
    /** The initial layout (default: one pane, named "main"). */
    layout?: WorkspaceData;
}

export class InertInterface implements Interface {
    interactions: AsyncIterable<IncomingInterfaceMessage | BucheErrorMessage>;

    constructor(interactions: AsyncIterable<IncomingInterfaceMessage | BucheErrorMessage>) {
        this.interactions = interactions;
    }

    processMessage(buche: Buche, message: OutgoingInterfaceMessage) {}
}

const ARROWS: Record<string, Direction> = {
    ArrowUp: "up",
    ArrowDown: "down",
    ArrowLeft: "left",
    ArrowRight: "right",
};

const isVisible = (el: HTMLElement): boolean =>
    el.isConnected &&
    !el.closest("[hidden]") &&
    (typeof el.checkVisibility === "function" ? el.checkVisibility() : true);

/** Layout operations (carreau's navigation mode: Alt+Q, then these). */
const navConfig = (layout: Layout): NavConfig => ({
    activation: { modifier: "Alt", code: "KeyQ", side: "either" },
    bindings: {
        ArrowLeft: "focusLeft",
        ArrowRight: "focusRight",
        ArrowUp: "focusUp",
        ArrowDown: "focusDown",
        "Shift+ArrowLeft": "expandLeft",
        "Shift+ArrowRight": "expandRight",
        "Shift+ArrowUp": "expandUp",
        "Shift+ArrowDown": "expandDown",
        KeyU: "unexpand",
        KeyL: "clear",
        KeyN: "namePane",
        KeyX: "mark",
        KeyV: "moveMarked",
        Comma: "prevTab",
        Period: "nextTab",
        Slash: "root",
        "Shift+Comma": "parent",
        "Shift+Period": "child",
        BracketRight: "growHeight",
        "Shift+BracketRight": "growWidth",
        BracketLeft: "shrinkHeight",
        "Shift+BracketLeft": "shrinkWidth",
        KeyM: "toggleMaximize",
        KeyF: "float",
        KeyG: "group",
        "Shift+KeyG": "collapse",
        "Shift+Digit5": "renameTab",
        KeyZ: "undo",
        "Shift+KeyZ": "redo",
        KeyW: "closeTab",
        "Shift+KeyW": "closePane",
    },
    prefixes: {
        // I, then: Enter, a new tab in the focused cell's pane; a direction,
        // in the pane on that side; Shift+direction, a new pane on that side.
        // What goes in it, the user then picks (see Layout's slots).
        KeyI: {
            Enter: () => layout.insert(),
            ArrowLeft: () => layout.insert("left"),
            ArrowRight: () => layout.insert("right"),
            ArrowUp: () => layout.insert("up"),
            ArrowDown: () => layout.insert("down"),
            "Shift+ArrowLeft": () => layout.insert("left", true),
            "Shift+ArrowRight": () => layout.insert("right", true),
            "Shift+ArrowUp": () => layout.insert("up", true),
            "Shift+ArrowDown": () => layout.insert("down", true),
        },
        KeyS: {
            ArrowLeft: "swapLeft",
            ArrowRight: "swapRight",
            ArrowUp: "swapUp",
            ArrowDown: "swapDown",
        },
        KeyA: {
            ArrowLeft: "moveIntoLeft",
            ArrowRight: "moveIntoRight",
            ArrowUp: "moveIntoUp",
            ArrowDown: "moveIntoDown",
            "Shift+ArrowLeft": "moveLeft",
            "Shift+ArrowRight": "moveRight",
            "Shift+ArrowUp": "moveUp",
            "Shift+ArrowDown": "moveDown",
        },
    },
});

export class BucheInterface implements Interface {
    container: HTMLElement;
    interactions: AsyncQueue<IncomingInterfaceMessage | BucheErrorMessage>;
    /** Where cells and prompts are (carreau; see layout.ts). */
    layout: Layout;
    /** Global keyboard bindings, listened for on `window` (see keybindings.ts). */
    keys: ModalKeys;
    /** Focus within and across cells (see focus.ts). Where the focus goes
     *  when its cell closes is the layout's call. */
    focus: FocusManager;
    /** Layout operations (Alt+Q). */
    nav: KeyboardNav;
    /** Counter for the ids given to user commands (see pushCommand). */
    private commandSeq = 0;
    /** The machine (to resolve addresses), once a message came from it. */
    private buche: Buche | null = null;

    constructor(args: BucheInterfaceArguments) {
        this.container = args.container;
        this.interactions = new AsyncQueue();
        this.focus = new FocusManager(this.container, {
            onLost: () => this.layout.commitFocus(),
        });
        this.layout = new Layout(
            {
                entryAt: (address) => this.buche?.hierarchy.getAt(address) ?? null,
                makeBox: (entry) => this.makeBox(entry),
                makeEditor: () => this.makeEditor(),
                focus: (el) => {
                    this.focus.focus(el, "nav");
                    if (!this.focus.holdCommits) {
                        this.focus.commitFocus();
                    }
                },
                signal: (entry, code) =>
                    this.interactions.push({ type: "user_signal", code, entry }),
                refocus: () => {
                    const current = this.focus.current;
                    if (current?.isConnected && !this.focus.holdCommits) {
                        this.focus.focus(current, "restore");
                        this.focus.commitFocus();
                    }
                },
                lastPrompt: () => this.lastPromptEntry(),
                run: (prompt, text, zone) => {
                    const id = `c${++this.commandSeq}`;
                    this.focus.expect(echoElementId(id));
                    this.interactions.push({
                        type: "user_command",
                        id,
                        entry: prompt,
                        text,
                        selection: { start: text.length, end: text.length },
                        command: "run",
                        zone,
                    });
                },
                spawn: (command, zone) =>
                    this.interactions.push({ type: "user_spawn", command, zone }),
            },
            this.container,
            args.layout,
            args,
        );
        // The layout's selection follows the focus.
        this.container.addEventListener("focus-change", (e: Event) => {
            const { current } = (e as CustomEvent<FocusChangeDetail>).detail;
            if (current) {
                this.layout.follow(current);
            }
        });
        this.nav = new KeyboardNav(this.layout.ws, this.layout.view, navConfig(this.layout));
        this.keys = this.installKeys();
        this.installGuiRelay();
    }

    // ── Cells and prompts ─────────────────────────────────────────────────────

    /** The box showing a cell, wired to the machine. */
    private makeBox(entry: Entry): EchoBox {
        const eb = new EchoBox();
        eb.setCompact(true);
        eb.setAttribute("bare", "");
        eb.bindEntry(entry);
        // Its ✕ is its tab's: closing goes through the layout.
        eb.addEventListener("close", () => this.closeEntry(entry));
        eb.addEventListener("resize", () => reportResize(this, eb, entry));
        // Keyboard input bubbles up from the embedded terminal (see EmbeddedTerm).
        eb.addEventListener("term-data", (e) => {
            entry.cell?.settle();
            this.interactions.push({
                type: "user_text",
                text: (e as CustomEvent<string>).detail,
                entry,
            });
        });
        // The embedded terminal appearing is the first moment a pty grid
        // exists to report: announce the size then.
        eb.addEventListener("term-appear", () => reportResize(this, eb, entry));
        if (entry.echo.id !== undefined) {
            eb.id = echoElementId(entry.echo.id);
        }
        return eb;
    }

    /** A prompt-column's editor: a prompt collection, wired to the machine. */
    private makeEditor(): PromptCollection {
        const pc = new PromptCollection();
        pc.setAttribute("single", "");
        pc.addEventListener("command", (event: PromptCommandEvent) => {
            this.pushCommand(event.detail);
        });
        pc.addEventListener("textchange", (event: PromptTextChangeEvent) => {
            this.interactions.push({
                type: "user_input",
                entry: event.detail.entry,
                text: event.detail.text,
                selection: event.detail.selection,
            });
        });
        return pc;
    }

    /** Close an entry's tab (see Layout: it ends its process). */
    private closeEntry(entry: Entry): void {
        const ws = this.layout.ws;
        for (const t of ws.trees()) {
            for (const tabId of tabIds(t)) {
                if (this.layout.entryOf(tabId) === entry) {
                    void ws.closeTab(tabId);
                    return;
                }
            }
        }
    }

    // ── GUI relay ─────────────────────────────────────────────────────────────
    // Messages a cell's <buche-gui> iframe relays out (`buche(data)`,
    // `buche.request`, exec results, `proc://` requests) are pushed into the
    // interactions as cell_gui_feedback, which routes them back to the entry's
    // process.

    private installGuiRelay(): void {
        this.container.addEventListener(GUI_SEND_EVENT, (e: Event) => {
            const el = e.target;
            if (!(el instanceof Element)) {
                return;
            }
            const detail = (e as CustomEvent).detail as Json;
            // `buche.leave()` is a terminal-level command, not app data: the
            // user explicitly left the GUI, so the focus abandons the cell
            // even if the cell is sticky (which only governs *normal* ends).
            if (
                typeof detail === "object" &&
                detail !== null &&
                !Array.isArray(detail) &&
                detail.type === "leave"
            ) {
                this.releaseCellFocus(el);
                return;
            }
            const entry = this.guiEntry(el);
            if (entry) {
                this.interactions.push({
                    type: "cell_gui_feedback",
                    entry,
                    data: detail,
                });
            }
        });
        // A GUI view that just came into existence takes the focus (unless
        // its cell is background, or a navigation is mid-capture).
        this.container.addEventListener(GUI_APPEAR_EVENT, (e: Event) => {
            const el = e.target;
            if (!(el instanceof HTMLElement)) {
                return;
            }
            const entry = this.guiEntry(el);
            if (entry?.echo.background) {
                return;
            }
            this.focus.focus(el, "auto");
            if (!this.focus.holdCommits) {
                this.focus.commitFocus();
            }
        });
        // In Electron, `proc://` requests answered by the natively registered
        // scheme are relayed from the main process by the preload bridge (see
        // electron/preload.ts); route them like any other GUI message. The
        // bridge also relays the menu's Cmd+W (close the current tab).
        window.addEventListener("message", (e: MessageEvent) => {
            if (e.source !== window) {
                return;
            }
            const d = e.data as {
                __buche?: string;
                cellId?: string;
                requestId?: string;
                path?: string;
                params?: Json;
                method?: string;
            } | null;
            if (d?.__buche === "window:closeTab") {
                this.closeCurrentTab();
                return;
            }
            if (d?.__buche !== "proc:request" || !d.cellId) {
                return;
            }
            const gui = this.container.querySelector(`buche-gui[proc-cell-id="${d.cellId}"]`);
            const entry = gui ? this.guiEntry(gui) : null;
            if (!entry) {
                return;
            }
            this.interactions.push({
                type: "cell_gui_feedback",
                entry,
                data: {
                    type: "resolve",
                    request_id: d.requestId ?? "",
                    path: d.path ?? "/",
                    params: d.params ?? {},
                    method: d.method ?? "GET",
                },
            });
        });
    }

    /** The entry of the cell showing the given GUI element: the entry bound
     *  to the <echo-box> it lives in. */
    private guiEntry(el: Element): Entry | null {
        const box = el.closest("echo-box");
        return box instanceof EchoBox ? box.boundEntry : null;
    }

    // ── Global key bindings ───────────────────────────────────────────────────
    // Chords ("Mod+p") are always live; capture mode (Ctrl+Q, held) taps keys
    // until Ctrl is released, which commits the focus (e.g. into the focused
    // cell's terminal):
    //   Ctrl+Tab /          switch to the next / previous tab of the current
    //   Ctrl+Shift+Tab      pane (the focus follows into the new tab); also
    //                       Mod+→ / Mod+←
    //   arrows        move the focus (neighbour, else layout jump)
    //   Shift+arrows  layout jump
    //   p             focus the latest prompt
    //   k / d         kill / close the focused cell — from a prompt, the cell
    //                 right above it
    //   l             clear all spent and standby cells (Ctrl+L clears only
    //                 those of the prompt's own stream, while typing in it)
    //   t             rename the window (popup, see title-editor.ts)
    // Extend or override through `iface.keys.on(...) / .onCapture(...) /
    // .onRelease(...)`.

    installKeys(): ModalKeys {
        const fm = this.focus;
        const move =
            (direction: Direction, mode: NavigationMode): KeyHandler =>
            () =>
                fm.move(direction, mode);
        const capture: Record<string, KeyHandler> = {
            p: () => this.focusPrompt(),
            k: () => this.killCell(),
            d: () => this.closeCell(),
            l: () => this.clearSpentCells(),
            t: () => {
                // The popup takes the DOM focus (outside the container); when
                // it closes, the focus goes back where it was.
                const previous = this.focus.current;
                showTitleEditor(() => {
                    if (previous?.isConnected) {
                        this.focus.focus(previous, "restore");
                        if (!this.focus.holdCommits) {
                            this.focus.commitFocus();
                        }
                    }
                });
            },
        };
        for (const [key, direction] of Object.entries(ARROWS)) {
            capture[key] = move(direction, "mix");
            capture[`Shift+${key}`] = move(direction, "jump");
        }
        const keys = new ModalKeys({
            chords: {
                "Mod+p": () => this.focusPrompt(),
                // C-l clears, but only in a prompt input: elsewhere it belongs
                // to what has the focus (a pty's clear-screen). In a prompt it
                // clears only that prompt's own shell view (the <buche-term>
                // hosting its prompt collection) — other tabs keep their
                // spent cells.
                "Ctrl+l": (e) => {
                    const target = e.target;
                    if (!(target instanceof Element) || !target.closest('[focusable="prompt"]')) {
                        return false;
                    }
                    this.clearStream(target);
                },
                "Ctrl+Tab": () => this.cycleTabs(true),
                "Ctrl+Shift+Tab": () => this.cycleTabs(false),
                "Mod+ArrowRight": () => this.cycleTabs(true),
                "Mod+ArrowLeft": () => this.cycleTabs(false),
            },
            enter: "Ctrl+q",
            capture,
            // Removing the focused cell mid-navigation must not commit the
            // focus that replaces it: releasing Ctrl will.
            onEnter: () => {
                fm.holdCommits = true;
            },
            release: () => {
                fm.holdCommits = false;
                fm.commitFocus();
            },
        });
        // Releasing Ctrl commits the focus, which can pull the DOM focus into a
        // terminal or an editor — back to the title popup's input, if it is up.
        keys.onRelease(() => refocusTitleEditor());
        keys.attach();
        // Every GUI iframe hands the capture-mode and navigation-mode chords,
        // and the tab-switching ones, to the page: typed inside a GUI, they
        // escape the iframe and run exactly as they do elsewhere.
        BucheGui.defaultInterceptChords = () => [
            keys.enter,
            // Carreau's navigation mode (see navConfig).
            "Alt+q",
            "Ctrl+Tab",
            "Ctrl+Shift+Tab",
            "Mod+ArrowRight",
            "Mod+ArrowLeft",
        ];
        return keys;
    }

    // ── Focus actions ─────────────────────────────────────────────────────────

    /** Give the keyboard focus to the layout's selected cell. */
    private commitSelection(): void {
        if (!this.focus.holdCommits) {
            this.layout.commitFocus();
        }
    }

    /** Switch to the next (or previous) tab of the selected pane; the focus
     *  follows. */
    cycleTabs(forward: boolean): void {
        this.layout.ws.run(forward ? "nextTab" : "prevTab");
        this.commitSelection();
    }

    /** Behave like the current tab's ✕ (it ends its process, the tab goes
     *  when it has). Bound to Cmd+W in Electron, where the menu routes it to
     *  `closeCurrentTab` through the preload bridge (the default menu's Cmd+W
     *  would close the whole window). */
    closeCurrentTab(): void {
        const tab = this.operandTab();
        if (tab) {
            void this.layout.ws.closeTab(tab);
        }
    }

    /** The tab cell actions apply to: the selected cell's or, from a prompt,
     *  the cell right above it (carreau's operand). */
    private operandTab(): string | null {
        const ws = this.layout.ws;
        const sel = ws.operand();
        const n = sel && !sel.range ? ws.node(sel.id) : null;
        return n?.type === "pane" ? (n.tabs[n.active]?.id ?? null) : null;
    }

    /** Focus the latest prompt focused in the history (bringing its tab back
     *  into view if needed). */
    focusPrompt(): void {
        const prompt = this.latestPrompt();
        if (!prompt) {
            return;
        }
        this.focus.focus(prompt, "nav");
        if (!this.focus.holdCommits) {
            this.focus.commitFocus();
        }
    }

    /** The live prompt focused last (else any live one). */
    private lastPromptEntry(): Entry | null {
        const live = (e: Entry | undefined | null): e is Entry => {
            const status = e?.prompt ? statusOf(e).status : "done";
            return status !== "done" && status !== "error";
        };
        for (const { element, tags } of [...this.focus.history].reverse()) {
            const pc = tags.includes("prompt")
                ? (element.closest("prompt-collection") as PromptCollection | null)
                : null;
            const entry = pc?.prompts.find((e) => pc.promptElement(e) === element);
            if (live(entry)) {
                return entry;
            }
        }
        return this.layout.anyPrompt();
    }

    private latestPrompt(): HTMLElement | null {
        for (const { element, tags } of [...this.focus.history].reverse()) {
            if (!tags.includes("prompt")) {
                continue;
            }
            if (isVisible(element)) {
                return element;
            }
            // Still there, but e.g. in a tab that was switched away from:
            // bring it back into view.
            const pc = element.closest("prompt-collection") as PromptCollection | null;
            const entry = pc?.prompts.find((e) => pc.promptElement(e) === element);
            const revealed = entry ? this.layout.revealPrompt(entry) : null;
            if (revealed && isVisible(revealed)) {
                return revealed;
            }
        }
        return null;
    }

    /** The cell that cell actions apply to (see operandTab). */
    targetCell(): EchoBox | null {
        const tab = this.operandTab();
        const entry = tab && this.layout.entryOf(tab);
        return (entry && this.layout.boxOf(entry)) || null;
    }

    /** SIGTERM (SIGKILL when already unresponsive) to the target cell, without
     *  closing it. */
    killCell(): void {
        const box = this.targetCell();
        const entry = box?.boundEntry;
        if (!box || !entry) {
            return;
        }
        // Nothing to kill once the process is spent — and signaling would
        // mark the entry (and its other views) unresponsive for nothing.
        if (box.status === "done" || box.status === "error") {
            return;
        }
        const code = box.status === "unresponsive" ? 9 : 15;
        this.interactions.push({ type: "user_signal", code, entry });
    }

    /** Behave exactly like clicking the target cell's ✕. */
    closeCell(): void {
        this.closeCurrentTab();
    }

    /** Clear the spent (and standby) cells everywhere: the standby ones are
     *  killed (see Layout). */
    clearSpentCells(): void {
        const ws = this.layout.ws;
        void ws.clear({ id: ws.root.id });
        for (const w of ws.floating) {
            void ws.clear({ id: w.root.id });
        }
    }

    /** Clear the spent cells of the stream a prompt element is in. */
    private clearStream(inside: Element): void {
        const id = inside.closest<HTMLElement>(".carreau-prompt[data-id], [data-id]")?.dataset.id;
        if (id) {
            void this.layout.ws.clear({ id });
        }
    }

    processMessage(buche: Buche, message: OutgoingInterfaceMessage) {
        this.buche = buche;
        type HT = (buche: Buche, m: OutgoingInterfaceMessage) => void;
        const handler = this[`handle$${message.type}`];
        (handler as HT).call(this, buche, message);
    }

    // ── Automatic focus ───────────────────────────────────────────────────────
    // A prompt command gets an id, which the driver repeats on the cell it
    // produces in response; the cell's element (see echoElementId) is then
    // expected, and takes the focus when it appears unless the focus moved in
    // the meantime, or the cell is `background`. When the focused cell's
    // process ends, the focus goes back to where it was, unless the cell is
    // `sticky`. A new prompt takes the focus unless it is `background`.

    /** Relay a prompt's command to the machine, expecting the cell answering it. */
    pushCommand(detail: PromptCommandDetail): void {
        const id = `c${++this.commandSeq}`;
        this.focus.expect(echoElementId(id));
        this.interactions.push({
            type: "user_command",
            id,
            entry: detail.entry,
            text: detail.text,
            selection: detail.selection,
            command: detail.command,
        });
    }

    // A background cell doesn't take the focus: drop the expectation of it.
    private settleExpectation(entry: Entry): void {
        const { id, background } = entry.echo;
        if (background && id !== undefined && this.focus.expecting === echoElementId(id)) {
            this.focus.expect(null);
        }
    }

    private focusNewPrompt(entry: Entry): void {
        if (entry.echo.background) {
            return;
        }
        const element = this.layout.revealPrompt(entry);
        if (element && isVisible(element)) {
            this.focus.focus(element, "auto");
            if (!this.focus.holdCommits) {
                this.focus.commitFocus();
            }
        }
    }

    // The focused cell's process ended: give the focus back, unless sticky.
    private releaseEndedCell(entry: Entry): void {
        const { status } = entry.echo.status;
        if (status !== "done" && status !== "error") {
            return;
        }
        // The focus may sit on the box itself, or anywhere inside it — the
        // GUI host (after buche.blur()), or the element committed in the
        // iframe.
        const current = this.focus.current;
        if (!current) {
            return;
        }
        const box = current.closest("echo-box");
        const ent = box instanceof EchoBox ? box.boundEntry : null;
        if (ent && (ent === entry || ent.representative() === entry)) {
            // Stickiness is a property of the echo on screen, which is not
            // the entry whose process ended when the echo only `represents`
            // it (a cell showing a process's output, say).
            if (!ent.echo.sticky && !entry.echo.sticky) {
                this.focus.back();
            }
        }
    }

    /** The user explicitly left the cell whose element contains `inside`
     *  (`buche.leave()` from its GUI): the focus abandons the cell — even a
     *  sticky one, since stickiness is about normal ends, not departures.
     *  The cell itself stays exactly as it was: alive, visible, re-enterable
     *  (a click, or navigating onto it, brings the focus back). */
    private releaseCellFocus(inside: Element): void {
        const box = inside.closest("echo-box");
        const before = this.focus.current;
        if (!box || !before || !(box === before || box.contains(before))) {
            return;
        }
        this.focus.back();
        const now = this.focus.current;
        if (now && now !== before && !box.contains(now)) {
            return;
        }
        // Nothing in the history outside the cell — typically the prompt that
        // launched the command: land there instead.
        this.focusPrompt();
    }

    // ── Interface messages ────────────────────────────────────────────────────

    handle$update_cell(buche: Buche, message: UpdateCellMessage) {
        const { entry, target } = message;
        this.settleExpectation(entry);
        if (!this.layout.has(entry) && target) {
            const box = this.layout.installCell(entry, target);
            // A placeholder takes input before any output: a terminal is
            // there for it, provisionally (a GUI coming first replaces it).
            if (entry.placeholder && entry.cell) {
                entry.cell.provideTerminal(entry, box);
            }
            if (box.id && this.focus.expecting === box.id) {
                this.focus.focus(box, "auto");
                this.commitSelection();
            }
        }
        // Re-apply on every box showing the entry.
        entry.fire();
    }

    handle$update_prompt(buche: Buche, message: UpdatePromptMessage) {
        const { entry, target } = message;
        if (this.layout.has(entry)) {
            // A placeholder that this prompt claimed: it becomes the prompt.
            if (this.layout.boxOf(entry) && entry.prompt) {
                this.layout.convertToPrompt(entry);
                this.focusNewPrompt(entry);
            }
            entry.fire();
        } else if (target) {
            this.layout.installPrompt(entry, target);
            this.focusNewPrompt(entry);
        }
    }

    handle$update_entry(buche: Buche, message: UpdateEntryMessage) {
        const { entry } = message;
        entry.fire();
        this.releaseEndedCell(entry);
        // What ends with its process (the entry, or the views standing for
        // it): ephemeral cells, and prompts (see Layout.promptEnded). Not what
        // runs below it: a sub-shell, its commands, outlive their shell.
        if (!killable(entry.echo)) {
            for (const e of entry.walk()) {
                if (e !== entry && e.representative() !== entry) {
                    continue;
                }
                if (e.prompt) {
                    this.layout.promptEnded(e);
                } else if (e.echo.ephemeral && this.layout.has(e)) {
                    this.layout.remove(e);
                }
            }
        }
        // A cell that ended may have been what kept an ended prompt's tab.
        this.layout.sweepEndedPrompts();
    }

    handle$cell_command(buche: Buche, message: CellCommandMessage) {
        const box = this.layout.boxOf(message.entry);
        if (box && message.entry.cell) {
            message.entry.cell.handle(message.command, message.entry, box);
        }
    }

    handle$problem(buche: Buche, message: ProblemMessage) {
        const code = message.subcode ? `${message.code}/${message.subcode}` : message.code;
        showToast(`${code}: ${message.reason}`);
    }
}

/** Every tab id of a tree. */
function* tabIds(root: LayoutNode): Generator<string> {
    for (const p of panes(root)) {
        for (const t of p.tabs) {
            yield t.id;
        }
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
function reportResize(ifc: BucheInterface, eb: EchoBox, entry: Entry): void {
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
