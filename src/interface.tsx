import { KeyboardNav, type NavAction, type WorkspaceData } from "carreau";
import { echoElementId, isSpent, killable } from "./cell.ts";
import { BucheGui, GUI_APPEAR_EVENT, GUI_SEND_EVENT } from "./components/buche-gui.tsx";
import { EchoBox } from "./components/echo-box.tsx";
import { EmbeddedTerm } from "./components/embedded-term.tsx";
import {
    PromptCollection,
    type PromptCommandDetail,
    type PromptCommandEvent,
    type PromptTextChangeEvent,
} from "./components/prompt-collection.tsx";
import { refocusTitleEditor, showTitleEditor } from "./components/title-editor.ts";
import { showToast } from "./components/toast.ts";
import {
    type BucheConfig,
    CARREAU_ACTIONS,
    frameChords,
    type Rule,
    resolveBindings,
} from "./config.ts";
import type { Buche } from "./core";
import type { Entry } from "./entry.ts";
import { type FocusChangeDetail, FocusManager } from "./focus.ts";
import type { IncomingInterfaceMessage } from "./interface-exchange/incoming";
import type {
    CellCommandMessage,
    OutgoingInterfaceMessage,
    ProblemMessage,
    UpdateCellMessage,
    UpdateEntryMessage,
} from "./interface-exchange/outgoing";
import { isMac } from "./keychord.ts";
import { Keymap } from "./keymap.ts";
import { Layout, type LayoutOptions } from "./layout.ts";
import type { Json, Target } from "./types.ts";
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
    /** The user's configuration (see config.ts), over the defaults. */
    config?: BucheConfig;
    /** The default configuration (config/default.yaml; if not given:
     *  BucheInterface.defaultConfig). */
    defaultConfig?: BucheConfig;
}

export class InertInterface implements Interface {
    interactions: AsyncIterable<IncomingInterfaceMessage | BucheErrorMessage>;

    constructor(interactions: AsyncIterable<IncomingInterfaceMessage | BucheErrorMessage>) {
        this.interactions = interactions;
    }

    processMessage(buche: Buche, message: OutgoingInterfaceMessage) {}
}

const isVisible = (el: HTMLElement): boolean =>
    el.isConnected &&
    !el.closest("[hidden]") &&
    (typeof el.checkVisibility === "function" ? el.checkVisibility() : true);

/** The gap between two rectangles (0 if they touch or overlap). */
const rectDistance = (a: DOMRect, b: DOMRect): number => {
    const dx = Math.max(0, b.left - a.right, a.left - b.right);
    const dy = Math.max(0, b.top - a.bottom, a.top - b.bottom);
    return Math.hypot(dx, dy);
};

export class BucheInterface implements Interface {
    /** The default configuration, when none is given (the pages always give
     *  it, see scripts/user-config.ts; the tests set this to
     *  config/default.yaml). */
    static defaultConfig: BucheConfig | null = null;

    container: HTMLElement;
    interactions: AsyncQueue<IncomingInterfaceMessage | BucheErrorMessage>;
    /** Where cells and prompts are (carreau; see layout.ts). */
    layout: Layout;
    /** The key bindings, listened for on `window` (see keymap.ts). */
    keys: Keymap;
    /** Focus within and across cells (see focus.ts). Where the focus goes
     *  when its cell closes is the layout's call. */
    focus: FocusManager;
    /** Layout operations (carreau's): their actions, and its navigation
     *  mode, on while a mode is (see keymap.ts). It listens to no keys. */
    nav: KeyboardNav;
    /** Counter for the ids given to user commands (see pushCommand). */
    private commandSeq = 0;
    /** The machine (to resolve addresses), once a message came from it. */
    private buche: Buche | null = null;

    constructor(args: BucheInterfaceArguments) {
        this.container = args.container;
        this.interactions = new AsyncQueue();
        const defaults = args.defaultConfig ?? BucheInterface.defaultConfig;
        if (!defaults) {
            throw new Error("buche: no default configuration (see config/default.yaml)");
        }
        // The user's configuration over the defaults.
        const { rules, errors } = resolveBindings([defaults, args.config], isMac());
        for (const error of errors) {
            showToast(`config: ${error}`);
        }
        this.focus = new FocusManager(this.container, {
            onLost: () => this.layout.commitFocus(),
        });
        this.layout = new Layout(
            {
                entryAt: (address) => this.buche?.hierarchy.getAt(address) ?? null,
                makeBox: (entry) => this.makeBox(entry),
                makeEditor: () => this.makeEditor(),
                focus: (el) => {
                    this.focus.focusAndCommit(el, "nav");
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
                        // The typed text, as a command line to run.
                        action: text,
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
        // The layout's selection follows the focus; the pop closes when the
        // focus leaves it (not mid-navigation: where it ends, see below).
        this.container.addEventListener("focus-change", (e: Event) => {
            const { current } = (e as CustomEvent<FocusChangeDetail>).detail;
            if (current) {
                this.layout.follow(current);
            }
            if (!this.focus.holdCommits) {
                this.layout.focusMoved(current);
            }
        });
        this.nav = new KeyboardNav(this.layout.ws, this.layout.view, { bindings: {} }, null);
        // Leaving a mode commits the focus to the selected cell: not away from
        // the window-title popup, if one is up.
        this.nav.onChange((state) => {
            // (During a navigation, nothing commits the focus: its end does.)
            this.focus.holdCommits = state !== "off";
            if (state === "off") {
                queueMicrotask(refocusTitleEditor);
                queueMicrotask(() => this.layout.focusMoved(this.focus.current));
            }
        });
        this.keys = this.installKeys(rules);
        this.installGuiRelay();
    }

    // ── Cells and prompts ─────────────────────────────────────────────────────

    /** The box showing a cell, wired to the machine. */
    private makeBox(entry: Entry): EchoBox {
        const eb = new EchoBox();
        eb.bindEntry(entry);
        eb.addEventListener("resize", () => reportResize(this, eb, entry));
        // Keyboard input bubbles up from the embedded terminal (see EmbeddedTerm).
        eb.addEventListener("term-data", (e) => {
            this.interactions.push({
                type: "user_text",
                text: (e as CustomEvent<string>).detail,
                entry,
            });
        });
        // The embedded terminal appearing is the first moment a pty grid
        // exists to report: announce the size then.
        eb.addEventListener("term-appear", () => reportResize(this, eb, entry));
        if (entry.cell.id !== undefined) {
            eb.id = echoElementId(entry.cell.id);
        }
        // `grow`: no height cap (see echo-box.css), kept up to date.
        const grow = () => eb.toggleAttribute("grow", entry.cell.grow);
        entry.listeners.push(grow);
        grow();
        return eb;
    }

    /** A prompt-column's editor: a prompt collection, wired to the machine. */
    private makeEditor(): PromptCollection {
        const pc = new PromptCollection();
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
        // A frame's GUI that just came into existence takes the focus (unless
        // its cell is background, or a navigation is mid-capture).
        this.container.addEventListener(GUI_APPEAR_EVENT, (e: Event) => {
            const el = e.target;
            if (!(el instanceof HTMLElement)) {
                return;
            }
            const entry = this.guiEntry(el);
            if (entry?.cell.background) {
                return;
            }
            this.focus.focusAndCommit(el, "auto");
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

    // ── Key bindings ──────────────────────────────────────────────────────────
    // As configured (see config.ts), matched by the keymap (keymap.ts), which
    // runs the actions here. Buche's own:
    //   focusPrompt   focus the closest visible prompt (see focusPrompt)
    //   clearPrompt   in a prompt: clear its stream's spent cells
    //   nextTab /     switch to the next / previous tab of the current pane
    //   prevTab       (the focus follows into the new tab)
    //   kill          kill the current cell (see killCell)
    //   renameWindow  rename the window
    //   insert...     a new tab, offering what goes in it (see Layout.insert)
    // (setMode and leaveMode are the keymap's.) The others are carreau's
    // layout operations; out of a mode, the selected cell takes the focus
    // after them.

    installKeys(rules: Rule[]): Keymap {
        const keys = new Keymap(rules, {
            run: (rule, e) => this.runAction(rule.action, e),
            context: (e) => {
                const t = e.target instanceof Element ? e.target : null;
                return {
                    inPrompt: !!t?.closest('[focusable="prompt"]'),
                    inPTY: !!t?.closest("embedded-term"),
                    inFrame: !!t?.closest("buche-gui"),
                };
            },
            setNavMode: (mode, commit) => this.nav.setMode(mode, commit),
        });
        keys.attach();
        // Every GUI iframe hands the chords of the rules that can apply in it
        // to the page: typed inside a GUI, they escape the iframe and run
        // exactly as they do elsewhere. (Once a mode is on, the focus has left
        // the iframe: its bindings are the page's.)
        const intercepted = frameChords(rules);
        BucheGui.defaultInterceptChords = () => intercepted;
        return keys;
    }

    /** Run a bound action (see installKeys). */
    runAction(action: string, e: KeyboardEvent): void {
        const m = /^insert(Into)?(Left|Right|Up|Down)$/.exec(action);
        if (m) {
            // Into the pane on that side, or (insertLeft...) a new pane there.
            const dir = m[2].toLowerCase() as "left" | "right" | "up" | "down";
            this.layout.insert(dir, !m[1]);
            return;
        }
        const own: Record<string, () => void> = {
            focusPrompt: () => this.focusPrompt(),
            // Only that prompt's own stream: other tabs keep their spent cells.
            clearPrompt: () => {
                const target = e.target;
                if (target instanceof Element && target.closest('[focusable="prompt"]')) {
                    this.clearStream(target);
                }
            },
            nextTab: () => this.cycleTabs(true),
            prevTab: () => this.cycleTabs(false),
            kill: () => this.killCell(),
            renameWindow: () => this.renameWindow(),
            insert: () => this.layout.insert(),
            insertInto: () => this.layout.insert(),
            insertFloat: () => this.layout.insertFloat(),
        };
        if (own[action]) {
            own[action]();
        } else if ((CARREAU_ACTIONS as string[]).includes(action)) {
            this.nav.run(action as NavAction);
            this.commitSelection();
        }
    }

    /** Rename the window (a popup: see title-editor.ts). It takes the DOM
     *  focus; when it closes, the focus goes back where it was. */
    renameWindow(): void {
        const previous = this.focus.current;
        showTitleEditor(() => {
            if (previous?.isConnected) {
                this.focus.focus(previous, "restore");
                this.focus.commitFocus();
            }
        });
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

    /**
     * Focus a prompt (Mod+p, and Alt+Q P): the visible live prompt closest to
     * the focus, else the latest one in the history (bringing its tab back
     * into view). In navigation mode, leave it: the prompt takes the focus.
     */
    focusPrompt(): void {
        const prompt = this.closestVisiblePrompt() ?? this.latestPrompt();
        if (!prompt) {
            return;
        }
        this.focus.focus(prompt, "nav");
        if (this.keys.mode) {
            this.keys.leave();
        } else if (!this.focus.holdCommits) {
            this.focus.commitFocus();
        }
    }

    /**
     * Of the live prompts shown, the one closest to the focus: one in the
     * same prompt-collection, else the nearest on screen; ties go to the one
     * focused last, then to the first in the page.
     */
    private closestVisiblePrompt(): HTMLElement | null {
        const candidates = [
            ...this.container.querySelectorAll<HTMLElement>('[focusable="prompt"]'),
        ].filter((el) => isVisible(el) && this.isLivePrompt(el));
        if (candidates.length === 0) {
            return null;
        }
        const ref = this.focus.current?.isConnected ? this.focus.current : null;
        const refRect = ref?.getBoundingClientRect();
        const history = this.focus.history.map((h) => h.element);
        const score = (el: HTMLElement): [number, number] => {
            const pc = el.closest("prompt-collection");
            const distance =
                !ref || !refRect
                    ? 0
                    : pc?.contains(ref)
                      ? -1
                      : rectDistance(refRect, el.getBoundingClientRect());
            return [distance, -history.lastIndexOf(el)];
        };
        const scored = candidates.map((el) => ({ el, score: score(el) }));
        scored.sort((a, b) => a.score[0] - b.score[0] || a.score[1] - b.score[1]);
        return scored[0].el;
    }

    /** Whether a prompt element shows a prompt that is still live (one we
     *  can't tell about counts as live). */
    private isLivePrompt(el: HTMLElement): boolean {
        const pc = el.closest("prompt-collection") as PromptCollection | null;
        const entry = pc?.entryOf(el);
        if (entry?.cell?.kind !== "prompt") {
            return true;
        }
        return !isSpent(entry.cell.status.status);
    }

    /** The live prompt focused last (else any live one). */
    private lastPromptEntry(): Entry | null {
        const live = (e: Entry | undefined | null): e is Entry =>
            e?.cell?.kind === "prompt" && !isSpent(e.cell.status.status);
        for (const { element, tags } of [...this.focus.history].reverse()) {
            const pc = tags.includes("prompt")
                ? (element.closest("prompt-collection") as PromptCollection | null)
                : null;
            const entry = pc?.entryOf(element);
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
            const entry = pc?.entryOf(element);
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
        // mark the entry unresponsive for nothing.
        const { status } = entry.cell.status;
        if (isSpent(status)) {
            return;
        }
        const code = status === "unresponsive" ? 9 : 15;
        this.interactions.push({ type: "user_signal", code, entry });
    }

    /** Behave exactly like clicking the target cell's ✕. UNUSED: nothing calls
     *  it for now (kept for planned use). */
    closeCell(): void {
        this.closeCurrentTab();
    }

    /** Clear the spent (and standby) cells everywhere: the standby ones are
     *  killed (see Layout). UNUSED: nothing calls it for now (kept for planned
     *  use). */
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
    // process ends, the focus goes back to where it was, if the cell is in a
    // prompt's stream and isn't `sticky`. A new prompt takes the focus unless
    // it is `background`.

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
            action: detail.action,
        });
    }

    // A background cell doesn't take the focus: drop the expectation of it.
    private settleExpectation(entry: Entry): void {
        const { id, background } = entry.cell;
        if (background && id !== undefined && this.focus.expecting === echoElementId(id)) {
            this.focus.expect(null);
        }
    }

    private focusNewPrompt(entry: Entry, force = false): void {
        if (entry.cell.background && !force) {
            return;
        }
        const element = this.layout.revealPrompt(entry);
        if (element && isVisible(element)) {
            this.focus.focusAndCommit(element, "auto");
        }
    }

    // The focused cell's process ended: give the focus back, if it is in a
    // prompt's stream and not sticky.
    private releaseEndedCell(entry: Entry): void {
        if (!isSpent(entry.cell.status.status)) {
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
        if (ent === entry) {
            // Its tab is being closed (that's why it ended): where the focus
            // goes is carreau's to decide once the tab is gone (in its tab
            // group or linked group: see `focusAfterClose`), not the history's,
            // which could be anywhere.
            if (this.layout.isClosing(entry)) {
                return;
            }
            // Only in a prompt's stream, where the prompt is right below:
            // elsewhere (its own tab or pane), the cell keeps the focus.
            if (!entry.cell.sticky && this.layout.inPromptColumn(entry)) {
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
        if (entry.cell.kind === "prompt") {
            this.updatePrompt(entry, target ?? null, message.focus === true);
            return;
        }
        this.settleExpectation(entry);
        if (!this.layout.has(entry) && target) {
            const box = this.layout.installCell(entry, target);
            entry.cell.initialize(entry, box);
            if (
                (box.id && this.focus.expecting === box.id) ||
                this.takesOverFocus(buche, entry, target)
            ) {
                this.focus.focus(box, "auto");
                this.commitSelection();
            }
        } else {
            // A claimed placeholder, say, given a kind: it gets its view.
            const box = this.layout.boxOf(entry);
            if (box) {
                entry.cell.initialize(entry, box);
            }
        }
        // Re-apply on every box showing the entry.
        entry.fire();
    }

    /**
     * Whether a process's view (`$stdout`, `$frame`) opening in a tab beside
     * another of its views takes the focus from it: the last one to come gets
     * it (a frame's GUI takes it as it appears, see GUI_APPEAR_EVENT).
     */
    private takesOverFocus(buche: Buche, entry: Entry, target: Target): boolean {
        if (!entry.field?.startsWith("$") || entry.cell.background || target.zone !== "tab") {
            return false;
        }
        const sibling = target.anchor ? buche.hierarchy.getAt(target.anchor) : null;
        const box = sibling ? this.layout.boxOf(sibling) : null;
        const current = this.focus.current;
        return !!box && !!current && (box === current || box.contains(current));
    }

    /** Show a prompt's update; `focus`: it was configured to take the focus
     *  (see PromptConfiguration.focus). */
    private updatePrompt(entry: Entry, target: Target | null, focus: boolean): void {
        if (this.layout.has(entry)) {
            // A placeholder that this prompt claimed: it becomes the prompt.
            if (this.layout.boxOf(entry)) {
                this.layout.convertToPrompt(entry);
                this.focusNewPrompt(entry, focus);
                entry.fire();
            } else {
                // (Its new content first: the focus lands on it.)
                entry.fire();
                if (focus) {
                    this.focusPromptOf(entry);
                }
            }
        } else if (target) {
            this.layout.installPrompt(entry, target);
            this.focusNewPrompt(entry, focus);
        }
    }

    /** Give a live prompt the focus, showing it (its tab) if hidden; out of
     *  navigation mode, like Mod+p. */
    private focusPromptOf(entry: Entry): void {
        const element = this.layout.revealPrompt(entry);
        if (!element) {
            return;
        }
        // (Anything still expected to take the focus would steal it back.)
        this.focus.expect(null);
        this.focus.focus(element, "nav");
        if (this.keys.mode) {
            this.keys.leave();
        } else if (!this.focus.holdCommits) {
            this.focus.commitFocus();
        }
    }

    handle$update_entry(buche: Buche, message: UpdateEntryMessage) {
        const { entry } = message;
        entry.fire();
        this.releaseEndedCell(entry);
        // What ends goes, if it is a prompt (see Layout.promptEnded) or
        // ephemeral. (A process's views end with it: its close reaches them.)
        if (!killable(entry.cell)) {
            if (entry.cell.kind === "prompt") {
                this.layout.promptEnded(entry);
            } else if (entry.cell.ephemeral && this.layout.has(entry)) {
                this.layout.remove(entry);
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
        const content = eb.content;
        const term = content instanceof EmbeddedTerm ? content.terminal : undefined;
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
