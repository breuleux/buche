// A cell's box, as a custom element: `<echo-box>`. It holds the cell's content
// — a terminal, or a frame (<buche-gui>) — in the layout, whose tab shows the
// cell's label and status and closes it.
//
//   const box = new EchoBox();
//   box.bindEntry(entry);
//   box.setContent(term);
//
// Sizing: a box in a scroll stream has a CSS `max-height` ceiling (see
// `maxContentHeight`), up to which its content sizes itself; a box that is its
// pane's whole content (the `fills` attribute, kept by the layout) fills it.
//
// Focus: the box is a focusable cell for the FocusManager (focus.ts): it is
// tagged `focusable="cell"` and takes the DOM focus itself while navigated
// onto, so the page keeps the keys; `commitFocus()` then moves the focus into
// its content (its embedded terminal or <buche-gui>). Setting the content
// asks the manager to commit again ("focus-commit-request"), so a terminal
// created while the box has the focus gets it.
//
// Events (bubbling):
//   "resize" — the cell's measured size changed. The box polls its cell size
//     once per frame, so *every* resize cause (a divider move, the window, a
//     tab coming back) funnels through this one event: at most once per frame,
//     and only when the measurement actually differs. A child terminal's
//     internal "term-resize" (its pty grid settled, e.g. a fresh terminal's
//     first real fit) forces the next tick to re-announce even unchanged
//     pixels.
//
// Appearance lives in the companion stylesheet `echo-box.css` (or the
// consolidated components.css).

import type { DomProps } from "myjsx/jsx-runtime";
import type { Entry } from "../entry.ts";
import type { FocusCommittable } from "../focus.ts";

/** The "resize" event (the cell's size changed) carries no detail. */
export type EchoResizeEvent = CustomEvent<null>;

/** Typed event map for {@link EchoBox} (drives `addEventListener`). */
export interface EchoBoxEventMap {
    resize: EchoResizeEvent;
}

export class EchoBox extends HTMLElement implements FocusCommittable {
    private initialized = false;
    private cellEl!: HTMLElement;
    // Cell-size polling, the single source of the "resize" event (see checkSize).
    private sizeFrame = 0;
    private lastWidth = -1;
    private lastHeight = -1;
    private wasHidden = false;
    // Set when a child terminal's pty grid changed ("term-resize"): forces the
    // next poll tick to announce even when the box's own pixels are unchanged.
    private ptyDirty = false;
    private _entry: Entry | null = null;

    connectedCallback(): void {
        this.ensureSetup();
        this.startSizePolling();
    }

    disconnectedCallback(): void {
        this.stopSizePolling();
    }

    // Moved (moveBefore: the layout re-renders around it), it stays as it is:
    // its size polling goes on, so that what the move changed is announced.
    connectedMoveCallback(): void {}

    // The cell size is polled once per frame (while connected), so the
    // "resize" event has exactly one source: any cause — a divider move, the
    // window, a tab returning to view — simply changes the measurement, and
    // the next frame turns that into at most one event. Hidden boxes (0×0) are
    // skipped; returning to view always fires once, so the embedded terminal
    // gets to re-derive its grid.
    private startSizePolling(): void {
        this.stopSizePolling();
        this.lastWidth = -1;
        this.lastHeight = -1;
        this.wasHidden = false;
        const step = () => {
            this.sizeFrame = requestAnimationFrame(step);
            this.checkSize();
        };
        this.sizeFrame = requestAnimationFrame(step);
    }

    private stopSizePolling(): void {
        if (this.sizeFrame !== 0) {
            cancelAnimationFrame(this.sizeFrame);
            this.sizeFrame = 0;
        }
    }

    private checkSize(): void {
        const { width, height } = this.cellSize;
        if (width === 0 && height === 0) {
            this.wasHidden = true;
            return;
        }
        const reappeared = this.wasHidden;
        const ptyChanged = this.ptyDirty;
        this.wasHidden = false;
        this.ptyDirty = false;
        const same = width === this.lastWidth && height === this.lastHeight;
        if (!reappeared && !ptyChanged && same) {
            return;
        }
        // The first frame while shown only sets the baseline; the size on
        // arrival is announced by the terminal's "term-appear" instead.
        if (this.lastWidth < 0 && !reappeared && !ptyChanged) {
            this.lastWidth = width;
            this.lastHeight = height;
            return;
        }
        this.lastWidth = width;
        this.lastHeight = height;
        this.dispatchEvent(new CustomEvent<null>("resize", { bubbles: true }));
    }

    // Typed event listeners for this element's custom events (see
    // {@link EchoBoxEventMap}); falls back to the standard signature.
    addEventListener<K extends keyof EchoBoxEventMap>(
        type: K,
        listener: (this: EchoBox, ev: EchoBoxEventMap[K]) => void,
        options?: boolean | AddEventListenerOptions,
    ): void;
    addEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions,
    ): void;
    addEventListener(type: string, listener: unknown, options?: unknown): void {
        super.addEventListener(
            type,
            listener as EventListenerOrEventListenerObject,
            options as boolean | AddEventListenerOptions,
        );
    }

    removeEventListener<K extends keyof EchoBoxEventMap>(
        type: K,
        listener: (this: EchoBox, ev: EchoBoxEventMap[K]) => void,
        options?: boolean | EventListenerOptions,
    ): void;
    removeEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | EventListenerOptions,
    ): void;
    removeEventListener(type: string, listener: unknown, options?: unknown): void {
        super.removeEventListener(
            type,
            listener as EventListenerOrEventListenerObject,
            options as boolean | EventListenerOptions,
        );
    }

    private ensureSetup(): void {
        if (this.initialized) {
            return;
        }
        this.initialized = true;
        if (!this.hasAttribute("focusable")) {
            this.setAttribute("focusable", "cell");
        }
        if (!this.hasAttribute("tabindex")) {
            this.tabIndex = -1;
        }
        // The cell: holds the content (a terminal, or a frame).
        this.cellEl = document.createElement("div");
        this.cellEl.className = "echo-box-cell";
        this.replaceChildren(this.cellEl);
        // A child terminal's pty-grid change may matter even when the box's
        // pixels did not move (a fresh terminal settling its first real fit).
        this.addEventListener("term-resize", () => {
            this.ptyDirty = true;
        });
    }

    // ── Focus ─────────────────────────────────────────────────────────────────

    /** Move the DOM focus into the content: its embedded terminal (so
     *  keystrokes reach the pty) or <buche-gui>. Otherwise the box keeps it. */
    commitFocus(): void {
        const target = this.cellEl.querySelector("embedded-term, buche-gui") as
            | (HTMLElement & Partial<FocusCommittable>)
            | null;
        if (!target) {
            return;
        }
        if (target.commitFocus) {
            target.commitFocus();
        } else {
            target.focus();
        }
    }

    // ── Sizing ──────────────────────────────────────────────────────────────

    /** The height in px the cell can reach before the box's CSS `max-height`
     *  clamps it, or null when the box imposes no ceiling. Content that sizes
     *  dynamically grows up to it. The cell's padding and borders come from
     *  its computed style (`offsetHeight - clientHeight` would only show
     *  borders — `clientHeight` includes the padding). */
    get maxContentHeight(): number | null {
        this.ensureSetup();
        const max = Number.parseFloat(getComputedStyle(this).maxHeight);
        if (!Number.isFinite(max)) {
            return null;
        }
        const style = getComputedStyle(this.cellEl);
        const inset =
            (Number.parseFloat(style.paddingTop) || 0) +
            (Number.parseFloat(style.paddingBottom) || 0) +
            (Number.parseFloat(style.borderTopWidth) || 0) +
            (Number.parseFloat(style.borderBottomWidth) || 0);
        return Math.max(0, max - inset);
    }

    /** The cell content area's rendered size, in CSS pixels. */
    get cellSize(): { height: number; width: number } {
        this.ensureSetup();
        return {
            height: this.cellEl.clientHeight,
            width: this.cellEl.clientWidth,
        };
    }

    // ── Entry binding ─────────────────────────────────────────────────────────

    /** The bound {@link Entry}: the one whose cell the box shows. */
    get boundEntry(): Entry | null {
        return this._entry;
    }

    bindEntry(entry: Entry): void {
        this._entry = entry;
    }

    unbindEntry(): void {
        this._entry = null;
    }

    // ── Content ───────────────────────────────────────────────────────────────

    /** What the box shows: its terminal or its frame (null: nothing yet). */
    get content(): HTMLElement | null {
        this.ensureSetup();
        return this.cellEl.firstElementChild as HTMLElement | null;
    }

    /** Show `content`, in place of what the box showed. If this box has the
     *  focus, it may now pass it on to the content (see commitFocus). */
    setContent(content: HTMLElement): void {
        this.ensureSetup();
        this.cellEl.replaceChildren(content);
        this.dispatchEvent(new Event("focus-commit-request", { bubbles: true }));
    }
}

if (typeof customElements !== "undefined") {
    if (!customElements.get("echo-box")) {
        customElements.define("echo-box", EchoBox);
    }
}

declare module "myjsx/jsx-runtime" {
    namespace JSX {
        interface CustomElements {
            "echo-box": DomProps<EchoBox>;
        }
    }
}
