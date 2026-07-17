import { EchoBox } from "./components/echo-box.tsx";
import { showToast } from "./components/toast.ts";
import { extractZones } from "./components/zone.tsx";
import type { Buche } from "./core";
import type { Entry } from "./entry.ts";
import { type Direction, FocusManager, type NavigationMode } from "./focus.ts";
import type { IncomingInterfaceMessage } from "./interface-exchange/incoming";
import type {
    CellCommandMessage,
    InstallEchoMessage,
    OutgoingInterfaceMessage,
    ProblemMessage,
    UpdateCellMessage,
    UpdateEntryMessage,
    UpdatePromptMessage,
} from "./interface-exchange/outgoing";
import { type KeyHandler, ModalKeys } from "./keybindings.ts";
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
    /** Global keyboard bindings installed on the container (see keybindings.ts). */
    keys: ModalKeys;
    /** Focus navigation across cells, prompts and zones (see focus.ts). */
    focus: FocusManager;

    constructor(args: BucheInterfaceArguments) {
        this.container = args.container;
        this.area = reifyTemplate(args.template);
        this.zones = extractZones(this.area as HTMLElement);
        this.interactions = new AsyncQueue();
        this.focus = new FocusManager(this.container as HTMLElement);
        this.keys = this.installKeys();
    }

    // ── Global key bindings ───────────────────────────────────────────────────
    // Chords ("Mod+p") are always live; capture mode (Ctrl+Q, held) taps keys
    // until Ctrl is released, which commits the focus (e.g. into the focused
    // cell's terminal):
    //   arrows        move the focus (neighbour, else layout jump)
    //   Shift+arrows  layout jump (out of the current zone)
    //   p             focus the latest prompt
    //   k / d         kill / close the focused cell — from a prompt, the cell
    //                 right above it
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
        };
        for (const [key, direction] of Object.entries(ARROWS)) {
            capture[key] = move(direction, "mix");
            capture[`Shift+${key}`] = move(direction, "jump");
        }
        const keys = new ModalKeys({
            chords: {
                "Mod+p": () => this.focusPrompt(),
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
        keys.attach(this.container);
        return keys;
    }

    // ── Focus actions ─────────────────────────────────────────────────────────

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

    /** The cell that cell actions apply to: the focused one or, when a prompt
     *  has the focus, the cell right above it (e.g. its latest output). */
    targetCell(): EchoBox | null {
        const fm = this.focus;
        let target = fm.current;
        if (target && fm.currentTags.includes("prompt")) {
            target = fm.find(target, "up", "neighbour");
        }
        return target instanceof EchoBox ? target : null;
    }

    /** SIGTERM (SIGKILL when already unresponsive) to the target cell, like
     *  its ✕ button, but without arming destroy-when-done. */
    killCell(): void {
        const box = this.targetCell();
        const entry = box?.boundEntry;
        if (!box || !entry) {
            return;
        }
        const code = box.status === "unresponsive" ? 9 : 15;
        this.interactions.push({ type: "user_signal", code, entry });
    }

    /** Behave exactly like clicking the target cell's ✕ button. */
    closeCell(): void {
        this.targetCell()?.dispatchEvent(new CustomEvent<null>("close", { bubbles: true }));
    }

    processMessage(buche: Buche, message: OutgoingInterfaceMessage) {
        console.log(message);
        type HT = (buche: Buche, m: OutgoingInterfaceMessage) => void;
        const handler = this[`handle$${message.type}`];
        (handler as HT).call(this, buche, message);
    }

    handle$install_echo(buche: Buche, message: InstallEchoMessage) {
        message.zone!.installEcho(this, message.entry);
    }

    handle$update_cell(buche: Buche, message: UpdateCellMessage) {
        const existing = this.map.get(message.entry);
        if (existing) {
            message.entry.fire();
        } else {
            const element = message.zone!.installCell(this, message.entry);
            this.map.set(message.entry, { zone: message.zone!, element });
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
        }
    }

    handle$update_entry(buche: Buche, message: UpdateEntryMessage) {
        message.entry.fire();
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
