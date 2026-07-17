import { BucheGui, GUI_APPEAR_EVENT, GUI_SEND_EVENT } from "./components/buche-gui.tsx";
import { EchoBox } from "./components/echo-box.tsx";
import type { PromptCollection, PromptCommandDetail } from "./components/prompt-collection.tsx";
import type { TabPane } from "./components/tab-pane.tsx";
import { refocusTitleEditor, showTitleEditor } from "./components/title-editor.ts";
import { showToast } from "./components/toast.ts";
import { extractZones } from "./components/zone.tsx";
import type { Buche } from "./core";
import { echoElementId } from "./echo.ts";
import type { Entry } from "./entry.ts";
import { type Direction, FocusManager, type NavigationMode } from "./focus.ts";
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
import type { Json } from "./types.ts";
import type { BucheErrorMessage } from "./utils";
import { AsyncQueue } from "./utils.ts";
import type { Zone } from "./zone";

export interface Interface {
    interactions: AsyncIterable<IncomingInterfaceMessage | BucheErrorMessage>;
    processMessage: (buche: Buche, message: OutgoingInterfaceMessage) => void;
    zones: Array<Zone>;
}

export interface BucheInterfaceArguments {
    container: Element;
    template: Element | string;
}

export class InertInterface implements Interface {
    interactions: AsyncIterable<IncomingInterfaceMessage | BucheErrorMessage>;
    zones: Array<Zone>;

    constructor(
        interactions: AsyncIterable<IncomingInterfaceMessage | BucheErrorMessage>,
        zones: Array<Zone>,
    ) {
        this.interactions = interactions;
        this.zones = zones;
    }

    processMessage(buche: Buche, message: OutgoingInterfaceMessage) {}
}

function reifyTemplate(template: Element | string): Element {
    if (typeof template !== "string") {
        return template;
    }
    const tpl = document.createElement("template");
    tpl.innerHTML = template;
    const element = tpl.content.firstElementChild;
    if (element === null) {
        throw new Error("Interface template did not produce an element");
    }
    return element;
}

const ARROWS: Record<string, Direction> = {
    ArrowUp: "up",
    ArrowDown: "down",
    ArrowLeft: "left",
    ArrowRight: "right",
};

const isVisible = (el: HTMLElement): boolean =>
    typeof el.checkVisibility === "function" ? el.checkVisibility() : true;

interface Reification {
    zone: Zone;
    element: HTMLElement;
}

export class BucheInterface implements Interface {
    container: Element;
    area: Element;
    interactions: AsyncQueue<IncomingInterfaceMessage | BucheErrorMessage>;
    zones: Array<Zone>;
    map: Map<Entry, Reification> = new Map();
    /** Global keyboard bindings, listened for on `window` (see keybindings.ts). */
    keys: ModalKeys;
    /** Focus navigation across cells, prompts and zones (see focus.ts). */
    focus: FocusManager;
    /** Counter for the ids given to user commands (see pushCommand). */
    private commandSeq = 0;

    constructor(args: BucheInterfaceArguments) {
        this.container = args.container;
        this.area = reifyTemplate(args.template);
        this.zones = extractZones(this.area as HTMLElement);
        this.interactions = new AsyncQueue();
        this.focus = new FocusManager(this.container as HTMLElement);
        this.keys = this.installKeys();
        this.installGuiRelay();
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
    //   Ctrl+Shift+Tab      tabbed zone (the focus follows into the new tab)
    //   arrows        move the focus (neighbour, else layout jump)
    //   Shift+arrows  layout jump (out of the current zone)
    //   p             focus the latest prompt
    //   k / d         kill / close the focused cell — from a prompt, the cell
    //                 right above it
    //   l             clear all spent cells (Ctrl+L does the same, but only
    //                 while typing in a prompt)
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
                // to what has the focus (a pty's clear-screen).
                "Ctrl+l": (e) => {
                    const target = e.target;
                    if (!(target instanceof Element) || !target.closest('[focusable="prompt"]')) {
                        return false;
                    }
                    this.clearSpentCells();
                },
                "Ctrl+Tab": () => this.cycleTabs(true),
                "Ctrl+Shift+Tab": () => this.cycleTabs(false),
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
        // Every GUI iframe hands the capture-mode chord and the tab-switching
        // chords to the page: typed inside a GUI, they escape the iframe and
        // run exactly as they do elsewhere.
        BucheGui.defaultInterceptChords = () => [keys.enter, "Ctrl+Tab", "Ctrl+Shift+Tab"];
        return keys;
    }

    // ── Focus actions ─────────────────────────────────────────────────────────

    /** The tab zone tab actions apply to: the one the focus is in, else the
     *  first one holding tabs. */
    private currentTabPane(): TabPane | null {
        const current = this.focus.current;
        const inside = current?.closest("tab-pane") as TabPane | null;
        return (
            inside ??
            [...this.container.querySelectorAll<TabPane>("tab-pane")].find((tp) => !tp.isEmpty) ??
            null
        );
    }

    /** Switch to the next (or previous) tab of the current tabbed zone. The
     *  focus follows into the new tab when it was inside the zone; the rest of
     *  the layout keeps it otherwise (Ctrl+Tab then only switches the view,
     *  like clicking a tab). */
    cycleTabs(forward: boolean): void {
        const current = this.focus.current;
        const pane = this.currentTabPane();
        if (pane === null || pane.cycleTab(forward) === null) {
            return;
        }
        if (current !== null && pane.contains(current)) {
            this.focus.focus(pane, "nav");
            if (!this.focus.holdCommits) {
                this.focus.commitFocus();
            }
        }
    }

    /** Behave like the current tab's ✕ button (SIGTERM the process, the tab
     *  goes when the box is gone). Bound to Cmd+W in Electron, where the menu
     *  routes it to `closeCurrentTab` through the preload bridge (the default
     *  menu's Cmd+W would close the whole window). */
    closeCurrentTab(): void {
        this.currentTabPane()?.closeActiveTab();
    }

    /** Focus the latest prompt focused in the history (or, if none, the first
     *  visible one). A prompt whose collection has since switched to another
     *  prompt stands for that collection's active prompt. */
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

    private latestPrompt(): HTMLElement | null {
        for (const { element, tags } of [...this.focus.history].reverse()) {
            if (!tags.includes("prompt")) {
                continue;
            }
            if (isVisible(element)) {
                return element;
            }
            // Still there, but e.g. in a tab that was switched away from (a
            // cell took the focus in a new tab): bring it back into view.
            const revealed = element.isConnected ? this.revealPrompt(element) : null;
            if (revealed && isVisible(revealed)) {
                return revealed;
            }
            // const active = element
            //     .closest("prompt-collection")
            //     ?.querySelector<HTMLElement>('[focusable="prompt"]:not([hidden])');
            // if (active && isVisible(active)) {
            //     return active;
            // }
        }
        // const prompts = this.container.querySelectorAll<HTMLElement>('[focusable="prompt"]');
        // return [...prompts].find(isVisible) ?? null;
        return null;
    }

    // Make a prompt's element visible again through its zone (see
    // Zone.revealPrompt), given the element.
    private revealPrompt(element: HTMLElement): HTMLElement | null {
        const pc = element.closest("prompt-collection") as PromptCollection | null;
        const entry = pc?.prompts.find((e) => pc.promptElement(e) === element);
        const zone = entry && this.map.get(entry)?.zone;
        return entry && zone ? zone.revealPrompt(entry) : null;
    }

    /** The cell that cell actions apply to: the focused one or, when a prompt
     *  has the focus, the cell right above it (e.g. its latest output). */
    targetCell(): EchoBox | null {
        const fm = this.focus;
        let target = fm.current;
        if (target && fm.currentTags.includes("prompt")) {
            target = fm.find(target, "up", "neighbour");
        }
        if (target instanceof EchoBox) {
            return target;
        }
        // The focus may sit on something inside the cell rather than the cell
        // itself — e.g. the <buche-gui> host, which takes it when a chord
        // escapes the iframe (Ctrl+Q). Cell actions apply to its box.
        const box = target?.closest("echo-box");
        return box instanceof EchoBox ? box : null;
    }

    /** SIGTERM (SIGKILL when already unresponsive) to the target cell, like
     *  its ✕ button, but without arming destroy-when-done. */
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

    /** Behave exactly like clicking the target cell's ✕ button. */
    closeCell(): void {
        this.targetCell()?.dispatchEvent(new CustomEvent<null>("close", { bubbles: true }));
    }

    /** Remove every spent cell (done or error), wherever it shows: log cells,
     *  tab cells (the tabs go with the boxes, see the "destroy" event), pop
     *  cells. Running cells are left alone — no signals are sent. */
    clearSpentCells(): void {
        for (const box of this.container.querySelectorAll("echo-box")) {
            if (box instanceof EchoBox && (box.status === "done" || box.status === "error")) {
                box.destroy();
            }
        }
    }

    processMessage(buche: Buche, message: OutgoingInterfaceMessage) {
        console.log(message);
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
            position: detail.position,
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

    private focusNewPrompt(zone: Zone, entry: Entry): void {
        if (entry.echo.background) {
            return;
        }
        const element = zone.revealPrompt(entry);
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
        for (const [ent, { element }] of this.map) {
            if (
                (ent === entry || ent.representative() === entry) &&
                (element === current || element.contains(current))
            ) {
                // Stickiness is a property of the echo on screen, which is not
                // the entry whose process ended when the echo only `represents`
                // it (a cell showing a process's output, say).
                if (ent.echo.sticky || entry.echo.sticky) {
                    continue;
                }
                this.focus.back();
                break;
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
        // launched the command, hidden in the tab the cell took over: land
        // there instead (which brings its tab back into view).
        this.focusPrompt();
    }

    // ── Interface messages ────────────────────────────────────────────────────

    handle$update_cell(buche: Buche, message: UpdateCellMessage) {
        this.settleExpectation(message.entry);
        if (!this.map.has(message.entry)) {
            const element = message.zone!.installCell(this, message.entry);
            this.map.set(message.entry, { zone: message.zone!, element });
        }
        // Re-apply on every box showing the entry, however it got there: a
        // cell installed in one zone (a tab) must also refresh the echo handle
        // of the same entry shown elsewhere (the prompt zone).
        message.entry.fire();
        // The configuration may have changed the mode (e.g. to unified, which
        // drops the terminal view); bring the box in line with it.
        const element = this.map.get(message.entry)?.element;
        if (element instanceof EchoBox && message.entry.cell) {
            message.entry.cell.applyMode(element);
        }
    }

    handle$update_prompt(buche: Buche, message: UpdatePromptMessage) {
        const existing = this.map.get(message.entry);
        if (existing) {
            message.entry.fire();
        } else {
            console.log("~~!", message.entry.echo.label);
            const element = message.zone!.installPrompt(this, message.entry);
            this.map.set(message.entry, { zone: message.zone!, element });
            this.focusNewPrompt(message.zone!, message.entry);
        }
    }

    handle$update_entry(buche: Buche, message: UpdateEntryMessage) {
        message.entry.fire();
        this.releaseEndedCell(message.entry);
    }

    handle$cell_command(buche: Buche, message: CellCommandMessage) {
        const existing = this.map.get(message.entry);
        if (existing && message.entry.cell) {
            message.entry.cell.handle(message.command, message.entry, existing.element as EchoBox);
        }
    }

    handle$problem(buche: Buche, message: ProblemMessage) {
        const code = message.subcode ? `${message.code}/${message.subcode}` : message.code;
        showToast(`${code}: ${message.reason}`);
    }
}
