// A submitted command and its output, as a custom element: `<echo-box>`.
//
//   <echo-box echo="ls -la" status="running" color="#6ea8fe">
//     <div data-view="pty">…</div>
//     <div data-view="gui">…</div>
//   </echo-box>
//
//   const box = document.createElement("echo-box") as EchoBox;
//   box.echo = "make build";
//   box.color = "#8ae234";
//   box.setView("pty", term);         // fill a view with content (icon from the map)
//   box.bump("gui");                  // flag the gui view as holding unseen content
//   box.status = "done";
//
// Layout:
//
//   ┌────┬───────────────────────────────────────────┐
//   │ ●  │ echo (the command line just submitted)  ▤◧✕│  ← status circle + echo + controls
//   │ │  ├───────────────────────────────────────────┤
//   │ │  │ cell — the active view's content            │  ← line runs down the gutter
//   └────┴───────────────────────────────────────────┘
//
// The left gutter is drawn (not a CSS margin): a status circle at the top and a
// straight line running down beside the cell. The cell holds one or more views
// (keyed by ViewLabel — pty, gui); each gets an icon button (glyph from a static
// map) at the top-right, and clicking one switches the visible view. A view can
// be flagged as holding unseen content with bump(label): while it is not the
// selected view its icon shows bright white. A closing icon sits after the view
// icons. The status
// circle and closing icon change appearance with the cell's `status`; the circle
// and line colour are configurable via the `color` attribute / `--echo-color`.
//
// The left gutter doubles as a resize handle: dragging *outward* from the bar
// grows the cell, dragging *inward* shrinks it. Concretely, grabbing the top
// half and dragging up (or the bottom half and dragging down) grows the cell;
// dragging the top half down (or the bottom half up) shrinks it. Set the
// `reverse` attribute to swap grow and shrink.
//
// The dragged half also stays anchored on screen: a top-half drag keeps the
// element's bottom edge fixed (the surrounding scroll position is adjusted to
// absorb the size change), while a bottom-half drag keeps the top edge fixed.
//
// Compact mode (`box.setCompact(true)` or the `compact` attribute) hides the
// coloured gutter bar and shows only the cell. The status, echo and controls
// reappear as a right-aligned top overlay — status · echo · buttons, an empty
// echo omitted — but only while the Alt/Option key is held with the pointer over
// that box (it is per-box, not global). The same gesture reveals short resize
// handles centred at the top and bottom edges.
//
// Events (both bubble). See the exported detail/event types below
// ({@link EchoViewChangeEvent}, {@link EchoCloseEvent}, {@link EchoBoxEventMap}):
//   "viewchange"  detail: { view: ViewLabel }  — the active view changed
//   "close"                                     — the closing icon was clicked
//
// Appearance lives in the companion stylesheet `echo-box.css` (or the
// consolidated components.css).

import type { DomProps } from "myjsx/jsx-runtime";
import { defaultTheme } from "../color.ts";
import type { Status, StatusString, ViewLabel } from "../echo.ts";
import type { Entry } from "../entry.ts";
import type { StyledText } from "../types.ts";
import { buildStyledText } from "./utils.tsx";

/** The box's visual status. Alias of the shared {@link StatusString}. */
export type EchoStatus = StatusString;

/** Map an {@link Echo}'s status onto the box's visual status. `absent` (an echo
 *  that hasn't started) is shown as `unresponsive`. */
function echoStatus(status: Status): StatusString {
    return status.status === "absent" ? "unresponsive" : status.status;
}

/** The icon glyph shown for each {@link ViewLabel}. */
export const VIEW_ICONS: Record<ViewLabel, string> = {
    pty: "▤",
    gui: "◧",
};

/** The tooltip / accessible label shown for each {@link ViewLabel}. */
export const VIEW_TITLES: Record<ViewLabel, string> = {
    pty: "Output",
    gui: "GUI",
};

export function isViewLabel(s: string): s is ViewLabel {
    return s in VIEW_ICONS;
}

interface ViewEntry {
    btn: HTMLButtonElement;
    view: HTMLElement;
    /** Whether the view may hold content the user hasn't seen yet. */
    unseen: boolean;
}

// ── Events ────────────────────────────────────────────────────────────────
// `detail` shapes and typed `CustomEvent` aliases for the events dispatched by
// {@link EchoBox}. All events bubble.

/** `detail` of the "viewchange" event: the active view changed. */
export interface EchoViewChangeDetail {
    view: ViewLabel;
}

export type EchoViewChangeEvent = CustomEvent<EchoViewChangeDetail>;
/** The "close" event (the ✕ was clicked) carries no detail. */
export type EchoCloseEvent = CustomEvent<null>;

/** Typed event map for {@link EchoBox} (drives `addEventListener`). */
export interface EchoBoxEventMap {
    viewchange: EchoViewChangeEvent;
    close: EchoCloseEvent;
}

const STATUSES: readonly EchoStatus[] = ["running", "done", "error", "unresponsive", "standby"];

function div(className: string): HTMLElement {
    const el = document.createElement("div");
    el.className = className;
    return el;
}

export class EchoBox extends HTMLElement {
    /**
     * Background/foreground lightness anchors used to resolve a {@link StyledText}
     * echo's accents into concrete colors. Defaults to the dark echo surface.
     */
    private initialized = false;
    private gutter!: HTMLElement;
    private statusEl!: HTMLElement;
    private echoEl!: HTMLElement;
    private headerEl!: HTMLElement;
    private controlsEl!: HTMLElement;
    private cellEl!: HTMLElement;
    private closeEl!: HTMLButtonElement;
    private inlineStatusEl!: HTMLElement;
    private handleTop!: HTMLElement;
    private handleBottom!: HTMLElement;
    private viewMap = new Map<ViewLabel, ViewEntry>();
    private _activeView: ViewLabel | null = null;
    private _status: EchoStatus = "running";
    private _compact = false;
    // The bound Entry (if configured from one) and the listener registered on it.
    private _entry: Entry | null = null;
    private entryListener: ((entry: Entry) => void) | null = null;
    // Whether the pointer is currently over this box. The compact overlay and
    // handles are shown only while Alt is held *and* the pointer is over the box,
    // so Alt-tracking is per-box (not global) and scoped to the hover.
    private hovering = false;
    private onAltKey = (e: KeyboardEvent) => this.syncAlt(e.altKey);
    private onAltBlur = () => this.syncAlt(false);

    static get observedAttributes(): string[] {
        return ["status", "color", "echo", "compact"];
    }

    connectedCallback(): void {
        this.ensureSetup();
    }

    disconnectedCallback(): void {
        this.stopHover();
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

    attributeChangedCallback(name: string, _old: string | null, value: string | null): void {
        // Initial values are read in ensureSetup; only react to later changes.
        if (!this.initialized) {
            return;
        }
        if (name === "status" && value) {
            this.status = value as EchoStatus;
        } else if (name === "color") {
            this.color = value ?? "";
        } else if (name === "echo") {
            this.setEcho(value ?? "");
        } else if (name === "compact") {
            const want = value !== null;
            if (want !== this._compact) {
                this.setCompact(want);
            }
        }
    }

    private ensureSetup(): void {
        if (this.initialized) {
            return;
        }
        this.initialized = true;

        // Capture authored `[data-view]` children as views before rebuilding.
        const authored = Array.from(this.children).filter(
            (c): c is HTMLElement => c instanceof HTMLElement && c.hasAttribute("data-view"),
        );
        this.replaceChildren();

        // Gutter: status circle at the top, line drawn beside the cell (CSS ::before).
        // It also acts as a drag handle to resize the cell.
        this.gutter = div("echo-box-gutter");
        this.statusEl = div("echo-box-status");
        this.gutter.append(this.statusEl);
        this.gutter.addEventListener("pointerdown", (e) => this.startResize(e));

        // Header: a status dot, the echo text, then controls (view icons, then
        // the closing icon). In compact mode this row becomes a right-aligned
        // overlay: status · echo · buttons — so an empty echo just closes up and
        // the status stays put beside the buttons.
        this.echoEl = div("echo-box-echo");
        this.controlsEl = div("echo-box-controls");
        // A second status dot that only shows in compact mode, where the gutter
        // (and its status circle) is hidden; here it sits to the left of the echo.
        this.inlineStatusEl = div("echo-box-status echo-box-status-inline");
        this.closeEl = document.createElement("button");
        this.closeEl.type = "button";
        this.closeEl.className = "echo-box-close";
        this.closeEl.textContent = "✕";
        this.closeEl.addEventListener("click", (e) => {
            e.stopPropagation();
            this.dispatchEvent(new CustomEvent<null>("close", { bubbles: true }));
        });
        this.controlsEl.append(this.closeEl);

        this.headerEl = div("echo-box-header");
        this.headerEl.append(this.inlineStatusEl, this.echoEl, this.controlsEl);

        // Cell: holds the views; only the active one is shown.
        this.cellEl = div("echo-box-cell");

        const body = div("echo-box-body");
        body.append(this.headerEl, this.cellEl);

        this.append(this.gutter, body);

        // Compact-mode resize handles at the very top and bottom edges. They are
        // hidden unless compact + Alt-hover (see the stylesheet) and drive the
        // same resize as the gutter, anchored to the top or bottom edge.
        this.handleTop = div("echo-box-handle echo-box-handle-top");
        this.handleBottom = div("echo-box-handle echo-box-handle-bottom");
        this.handleTop.addEventListener("pointerdown", (e) => this.startResize(e, true));
        this.handleBottom.addEventListener("pointerdown", (e) => this.startResize(e, false));
        this.append(this.handleTop, this.handleBottom);

        // Reveal the compact overlay/handles only while the pointer is over this
        // box and Alt is held. Key listeners are attached only during the hover.
        this.addEventListener("pointerenter", (e) => this.startHover(e as PointerEvent));
        this.addEventListener("pointermove", (e) => {
            if (this.hovering) {
                this.syncAlt((e as PointerEvent).altKey);
            }
        });
        this.addEventListener("pointerleave", () => this.stopHover());

        // Apply initial configuration from attributes.
        this._status = (this.getAttribute("status") as EchoStatus) ?? "running";
        this.applyStatus();
        const color = this.getAttribute("color");
        if (color) {
            this.style.setProperty("--echo-color", this.resolveColor(color));
        }
        const echo = this.getAttribute("echo");
        if (echo != null) {
            this.setEcho(echo);
        }

        for (const child of authored) {
            const lbl = child.getAttribute("data-view") ?? "";
            if (isViewLabel(lbl)) {
                this.setView(lbl, child);
            }
        }
        this.updateControlsState();

        if (this.hasAttribute("compact")) {
            this.setCompact(true);
        }
    }

    // ── Resize (drag the gutter handle) ───────────────────────────────────────

    /** Drag the gutter (or a compact-mode handle) to grow/shrink the cell:
     *  outward grows, inward shrinks. `forcedTopHalf` pins the anchored edge for
     *  the top/bottom handles; when omitted the grabbed half of the gutter
     *  decides. */
    private startResize(event: PointerEvent, forcedTopHalf?: boolean): void {
        // Ignore anything but a primary-button / touch / pen press.
        if (event.button !== 0) {
            return;
        }
        event.preventDefault();
        // The element the drag started on (the gutter or one of the handles);
        // pointer capture and the move/up listeners all live on it.
        const source = event.currentTarget as HTMLElement;
        source.setPointerCapture(event.pointerId);
        source.classList.add("resizing");

        const startY = event.clientY;
        // Continue from the last explicit height if we set one (keeps repeated
        // drags exact); otherwise start from the cell's current rendered height.
        const explicit = Number.parseFloat(this.cellEl.style.height);
        const startHeight = Number.isFinite(explicit)
            ? explicit
            : this.cellEl.getBoundingClientRect().height;

        // Which half of the bar the drag started on sets the "outward" direction:
        // from the top half, up is outward; from the bottom half, down is outward.
        // Dragging outward grows the cell, inward shrinks it; `reverse` swaps them.
        // The bar alongside the top line (the header/echo row, above the cell)
        // always counts as the top half, even on a short bar where the geometric
        // middle would fall within it. A handle passes its edge in explicitly.
        let topHalf: boolean;
        if (forcedTopHalf !== undefined) {
            topHalf = forcedTopHalf;
        } else {
            const rect = source.getBoundingClientRect();
            const cellTop = this.cellEl.getBoundingClientRect().top;
            topHalf = startY < Math.max(rect.top + rect.height / 2, cellTop);
        }
        const outward = topHalf ? 1 : -1;
        const sign = (this.hasAttribute("reverse") ? -1 : 1) * outward;

        // The dragged half stays put on screen: a top-half drag anchors the
        // element's bottom edge, a bottom-half drag anchors its top edge. Rather
        // than assume how the container reacts to the size change, we measure the
        // anchored edge and scroll to cancel whatever drift the resize caused. In
        // a normal (top-pinned) container that drift is the whole height change; in
        // a bottom-pinned one like <scroll-fader> the growth already shifts the
        // content, so the drift — and the correction — is near zero.
        const scroller = this.resolveScrollParent();
        const anchorEdge = (): number => {
            const r = this.getBoundingClientRect();
            return topHalf ? r.bottom : r.top;
        };
        const anchor = anchorEdge();

        const onMove = (e: PointerEvent) => {
            // `upAmount` is positive when moving up; `sign` maps it onto grow/shrink.
            const upAmount = startY - e.clientY;
            const height = Math.max(0, startHeight + upAmount * sign);
            this.cellEl.style.height = `${height}px`;
            // Counter-scroll by however far the anchored edge actually drifted.
            scroller.scrollTop += anchorEdge() - anchor;
        };

        const onUp = (e: PointerEvent) => {
            source.releasePointerCapture(e.pointerId);
            source.classList.remove("resizing");
            source.removeEventListener("pointermove", onMove);
            source.removeEventListener("pointerup", onUp);
            source.removeEventListener("pointercancel", onUp);
        };

        source.addEventListener("pointermove", onMove);
        source.addEventListener("pointerup", onUp);
        source.addEventListener("pointercancel", onUp);
    }

    /** The nearest scrollable ancestor, falling back to the document scroller. */
    private resolveScrollParent(): HTMLElement {
        for (let el = this.parentElement; el; el = el.parentElement) {
            const overflowY = getComputedStyle(el).overflowY;
            const scrollable =
                overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay";
            if (scrollable && el.scrollHeight > el.clientHeight) {
                return el;
            }
        }
        return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
    }

    // ── Status ──────────────────────────────────────────────────────────────

    /** The cell's status; drives the status circle and closing-icon appearance. */
    get status(): EchoStatus {
        this.ensureSetup();
        return this._status;
    }

    set status(value: EchoStatus) {
        this.ensureSetup();
        this._status = STATUSES.includes(value) ? value : "running";
        this.applyStatus();
    }

    private applyStatus(): void {
        // A data-attribute on the host drives all status-dependent CSS.
        this.setAttribute("data-status", this._status);
        const alive =
            this._status === "running" ||
            this._status === "unresponsive" ||
            this._status === "standby";
        this.closeEl.title = alive ? "Kill" : "Close";
        this.closeEl.setAttribute("aria-label", this.closeEl.title);
    }

    // ── Colour ──────────────────────────────────────────────────────────────

    /** The resolved status-circle and gutter-line colour (the `--echo-color` var). */
    get color(): string {
        this.ensureSetup();
        return this.style.getPropertyValue("--echo-color").trim();
    }

    /**
     * Set the status-circle / gutter-line colour. The value is an accent parsed
     * through {@link defaultTheme} (e.g. `"green"`, `"blue L80"`); a value that
     * isn't a valid accent is used verbatim, so plain CSS colours still work.
     */
    set color(value: string) {
        this.ensureSetup();
        if (value) {
            this.style.setProperty("--echo-color", this.resolveColor(value));
        } else {
            this.style.removeProperty("--echo-color");
        }
    }

    /** Resolve a colour accent to a CSS colour, falling back to the raw value
     *  when it cannot be parsed (already a CSS colour like `#8ae234`). */
    private resolveColor(value: string): string {
        try {
            return defaultTheme.calculateColor(value);
        } catch {
            return value;
        }
    }

    // ── Compact mode ──────────────────────────────────────────────────────────

    /** Whether the box is in compact mode. */
    get compact(): boolean {
        this.ensureSetup();
        return this._compact;
    }

    set compact(on: boolean) {
        this.setCompact(on);
    }

    /** Switch compact mode on or off. In compact mode the coloured bar is gone;
     *  the status, echo and controls appear only as a right-aligned overlay while
     *  Alt/Option is held over the box (an empty echo is omitted, and the status
     *  sits to the left of the echo), and the same gesture reveals short
     *  top/bottom resize handles in the middle. */
    setCompact(on: boolean): void {
        this.ensureSetup();
        on = Boolean(on);
        this._compact = on;
        this.toggleAttribute("compact", on);
        if (!on) {
            this.stopHover();
        }
    }

    // Begin tracking Alt for this box while the pointer is over it.
    private startHover(event: PointerEvent): void {
        if (!this._compact) {
            return;
        }
        this.hovering = true;
        window.addEventListener("keydown", this.onAltKey);
        window.addEventListener("keyup", this.onAltKey);
        // Alt is released "silently" on blur (e.g. Alt+Tab); clear it then.
        window.addEventListener("blur", this.onAltBlur);
        this.syncAlt(event.altKey);
    }

    // Stop tracking Alt and hide the overlay/handles.
    private stopHover(): void {
        this.hovering = false;
        window.removeEventListener("keydown", this.onAltKey);
        window.removeEventListener("keyup", this.onAltKey);
        window.removeEventListener("blur", this.onAltBlur);
        this.syncAlt(false);
    }

    // Reflect "compact + hovering + Alt down" to the `data-alt` attribute the
    // stylesheet keys the overlay and handles on. On the way in, the overlay is
    // pinned to its current viewport spot (see pinOverlay) so it stays put.
    private syncAlt(down: boolean): void {
        const active = this._compact && this.hovering && down;
        const wasActive = this.hasAttribute("data-alt");
        if (active === wasActive) {
            return;
        }
        this.toggleAttribute("data-alt", active);
        if (active) {
            this.pinOverlay();
        } else {
            this.unpinOverlay();
        }
    }

    // Freeze the overlay at its current on-screen position (`position: fixed`)
    // while it is active, so that a resize triggered from within it — e.g. the
    // cell growing after a view-switch click — doesn't shift it out from under
    // the pointer. Measured after `data-alt` is set so the rect is the laid-out
    // overlay position.
    private pinOverlay(): void {
        const rect = this.headerEl.getBoundingClientRect();
        const style = this.headerEl.style;
        style.position = "fixed";
        style.top = `${rect.top}px`;
        style.left = `${rect.left}px`;
        style.right = "auto";
        style.width = `${rect.width}px`;
    }

    private unpinOverlay(): void {
        const style = this.headerEl.style;
        style.position = "";
        style.top = "";
        style.left = "";
        style.right = "";
        style.width = "";
    }

    // ── Echo (the submitted command line) ─────────────────────────────────────

    get echo(): string {
        this.ensureSetup();
        return this.echoEl.textContent ?? "";
    }

    set echo(value: string | Node | StyledText) {
        this.setEcho(value);
    }

    /**
     * Set the echo to plain text, a rich node (e.g. a highlighted command), or a
     * {@link StyledText} — whose text and highlight ranges are rendered through
     * {@link buildStyledText} against {@link anchors}.
     */
    setEcho(content: string | Node | StyledText): void {
        this.ensureSetup();
        if (typeof content === "string") {
            this.echoEl.textContent = content;
        } else if (content instanceof Node) {
            this.echoEl.replaceChildren(content);
        } else {
            this.echoEl.replaceChildren(buildStyledText(content, defaultTheme));
        }
    }

    // ── Entry binding ───────────────────────────────────────────────────────────

    /** The bound {@link Entry}, if the box was configured from one. */
    get boundEntry(): Entry | null {
        this.ensureSetup();
        return this._entry;
    }

    /**
     * Configure the box from an {@link Entry}: apply its Echo's command text,
     * colour, status and views now, and re-apply on every subsequent
     * `entry.fire()`. Any previously bound entry is detached first.
     */
    bindEntry(entry: Entry): void {
        this.ensureSetup();
        this.unbindEntry();
        this._entry = entry;
        this.entryListener = () => this.applyEntry(entry);
        entry.listeners.push(this.entryListener);
        this.applyEntry(entry);
    }

    /** Detach the current entry's reconfiguration listener (if any). */
    unbindEntry(): void {
        if (this._entry && this.entryListener) {
            this._entry.listeners = this._entry.listeners.filter((l) => l !== this.entryListener);
        }
        this._entry = null;
        this.entryListener = null;
    }

    private applyEntry(entry: Entry): void {
        const echo = entry.echo;
        if (echo?.echo !== undefined) {
            this.setEcho(echo.echo);
        }
        this.color = echo.color ?? "";
        this.status = echoStatus(echo.status);
        // The echo's `views` set drives which view icons exist.
        if (echo.views) {
            for (const lbl of echo.views) {
                this.ensureView(lbl);
            }
        }
    }

    // ── Views ─────────────────────────────────────────────────────────────────

    /** The registered view labels, in insertion order. */
    get views(): ViewLabel[] {
        this.ensureSetup();
        return [...this.viewMap.keys()];
    }

    /** The currently visible view, or null if there are no views. */
    get activeView(): ViewLabel | null {
        this.ensureSetup();
        return this._activeView;
    }

    /** Set (replace) a view's content, creating the view — and its icon, from the
     *  static {@link VIEW_ICONS} map — if it doesn't exist yet. The first view
     *  created becomes active. Returns the view's content container. */
    setView(lbl: ViewLabel, content: Node): HTMLElement {
        this.ensureSetup();
        const entry = this.ensureView(lbl);
        entry.view.replaceChildren(content);
        return entry.view;
    }

    /** Flag that a view may hold content the user hasn't seen yet: its icon is
     *  shown in bright white while the view is not the selected one. Selecting
     *  the view (see {@link showView}) clears the flag. */
    bump(lbl: ViewLabel): void {
        this.ensureSetup();
        const entry = this.ensureView(lbl);
        // The active view's content is already on screen, so nothing is unseen.
        entry.unseen = this._activeView !== lbl;
        this.updateViewStyles();
    }

    /** Remove a view; if it was active, the next view (if any) becomes active. */
    removeView(lbl: ViewLabel): void {
        this.ensureSetup();
        const entry = this.viewMap.get(lbl);
        if (!entry) {
            return;
        }
        entry.btn.remove();
        entry.view.remove();
        this.viewMap.delete(lbl);
        if (this._activeView === lbl) {
            this._activeView = null;
            const next = this.viewMap.keys().next();
            if (!next.done) {
                this.showView(next.value);
            }
        }
        this.updateControlsState();
    }

    /** Switch to a view. No-op for a view that doesn't exist. */
    showView(lbl: ViewLabel): void {
        this.ensureSetup();
        const entry = this.viewMap.get(lbl);
        if (!entry) {
            return;
        }
        this._activeView = lbl;
        // Viewing it means its content is now seen.
        entry.unseen = false;
        for (const [vid, e] of this.viewMap) {
            e.view.hidden = vid !== lbl;
        }
        this.updateViewStyles();
        this.dispatchEvent(
            new CustomEvent<EchoViewChangeDetail>("viewchange", {
                detail: { view: lbl },
                bubbles: true,
            }),
        );
    }

    /** The content container for a view, or null if unknown. */
    getView(lbl: ViewLabel): HTMLElement | null {
        this.ensureSetup();
        return this.viewMap.get(lbl)?.view ?? null;
    }

    // Create a view (and its icon button) if it doesn't exist yet.
    private ensureView(lbl: ViewLabel): ViewEntry {
        const existing = this.viewMap.get(lbl);
        if (existing) {
            return existing;
        }

        const view = div("echo-box-view");
        view.setAttribute("data-view", lbl);
        view.hidden = true;
        this.cellEl.append(view);

        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "echo-box-view-btn";
        btn.setAttribute("data-view", lbl);
        btn.textContent = VIEW_ICONS[lbl];
        btn.title = VIEW_TITLES[lbl];
        btn.setAttribute("aria-label", btn.title);
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            this.showView(lbl);
        });
        this.controlsEl.insertBefore(btn, this.closeEl);

        const entry: ViewEntry = { btn, view, unseen: false };
        this.viewMap.set(lbl, entry);
        if (this._activeView === null) {
            this.showView(lbl);
        }
        this.updateControlsState();
        return entry;
    }

    // Reflect the active view and the per-view "unseen" flag onto the icons. A
    // view flagged unseen shows bright white until it becomes the selected one.
    private updateViewStyles(): void {
        for (const [vid, { btn, unseen }] of this.viewMap) {
            const active = vid === this._activeView;
            btn.classList.toggle("active", active);
            btn.classList.toggle("has-unseen", unseen && !active);
            btn.setAttribute("aria-pressed", String(active));
        }
    }

    // With 0 or 1 views there is nothing to switch between, so hide the icons.
    private updateControlsState(): void {
        this.controlsEl.classList.toggle("single-view", this.viewMap.size <= 1);
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
