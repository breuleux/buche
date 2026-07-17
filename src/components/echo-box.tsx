// A submitted command and its output, as a custom element: `<echo-box>`.
//
//   <echo-box echo="ls -la" status="running" color="#6ea8fe">
//     <div data-view="stdout" data-icon="▤" data-label="Output">…</div>
//     <div data-view="gui"    data-icon="◧" data-label="GUI">…</div>
//   </echo-box>
//
//   const box = document.createElement("echo-box") as EchoBox;
//   box.echo = "make build";
//   box.color = "#8ae234";
//   const out = box.addView({ id: "stdout", icon: "▤", label: "Output" });
//   out.appendChild(term);            // fill the view with content
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
// (stdout, gui, …); each gets an icon button at the top-right, and clicking one
// switches the visible view. A closing icon sits after the view icons. The status
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
// Events (both bubble):
//   "viewchange"  detail: { view: string }   — the active view changed
//   "close"                                   — the closing icon was clicked
//
// Appearance lives in the companion stylesheet `echo-box.css` (or the
// consolidated components.css).

import type { DomProps } from "myjsx/jsx-runtime";
import type { Anchors } from "../color.ts";
import type { StyledText } from "../types.ts";
import { buildStyledText } from "./utils.tsx";

export type EchoStatus = "running" | "done" | "error" | "unresponsive" | "standby";

export interface EchoView {
    /** Stable identifier used to switch to / address the view. */
    id: string;
    /** Glyph (or short text) for the view's icon button. */
    icon?: string;
    /** Tooltip / accessible label for the icon button. */
    label?: string;
    /** Initial content node placed inside the view. */
    content?: Node;
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
    anchors: Anchors = { bg: 0.18, fg: 0.9 };

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
    private viewMap = new Map<string, { btn: HTMLButtonElement; view: HTMLElement }>();
    private _activeView: string | null = null;
    private _status: EchoStatus = "running";
    private _compact = false;
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
            this.dispatchEvent(new CustomEvent("close", { bubbles: true }));
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
            this.style.setProperty("--echo-color", color);
        }
        const echo = this.getAttribute("echo");
        if (echo != null) {
            this.setEcho(echo);
        }

        for (const child of authored) {
            this.addView({
                id: child.getAttribute("data-view") ?? "",
                icon: child.getAttribute("data-icon") ?? undefined,
                label: child.getAttribute("data-label") ?? undefined,
                content: child,
            });
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

    /** The status-circle and gutter-line colour (sets the `--echo-color` var). */
    get color(): string {
        this.ensureSetup();
        return this.style.getPropertyValue("--echo-color").trim();
    }

    set color(value: string) {
        this.ensureSetup();
        if (value) {
            this.style.setProperty("--echo-color", value);
        } else {
            this.style.removeProperty("--echo-color");
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
            this.echoEl.replaceChildren(buildStyledText(content, this.anchors));
        }
    }

    // ── Views ─────────────────────────────────────────────────────────────────

    /** The registered view ids, in insertion order. */
    get views(): string[] {
        this.ensureSetup();
        return [...this.viewMap.keys()];
    }

    /** The currently visible view id, or null if there are no views. */
    get activeView(): string | null {
        this.ensureSetup();
        return this._activeView;
    }

    /** Add a view (and its icon button). The first view added becomes active.
     *  If the id already exists, its content is replaced. Returns the view's
     *  content container to append into. */
    addView(spec: EchoView): HTMLElement {
        this.ensureSetup();
        const id = spec.id;
        const existing = this.viewMap.get(id);
        if (existing) {
            if (spec.content) {
                existing.view.replaceChildren(spec.content);
            }
            return existing.view;
        }

        const view = div("echo-box-view");
        view.setAttribute("data-view", id);
        view.hidden = true;
        if (spec.content) {
            view.append(spec.content);
        }
        this.cellEl.append(view);

        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "echo-box-view-btn";
        btn.setAttribute("data-view", id);
        btn.textContent = spec.icon ?? id.slice(0, 1).toUpperCase();
        btn.title = spec.label ?? id;
        btn.setAttribute("aria-label", btn.title);
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            this.showView(id);
        });
        this.controlsEl.insertBefore(btn, this.closeEl);

        this.viewMap.set(id, { btn, view });
        if (this._activeView === null) {
            this.showView(id);
        }
        this.updateControlsState();
        return view;
    }

    /** Remove a view; if it was active, the next view (if any) becomes active. */
    removeView(id: string): void {
        this.ensureSetup();
        const entry = this.viewMap.get(id);
        if (!entry) {
            return;
        }
        entry.btn.remove();
        entry.view.remove();
        this.viewMap.delete(id);
        if (this._activeView === id) {
            this._activeView = null;
            const next = this.viewMap.keys().next();
            if (!next.done) {
                this.showView(next.value);
            }
        }
        this.updateControlsState();
    }

    /** Switch to a view by id. No-op for an unknown id. */
    showView(id: string): void {
        this.ensureSetup();
        if (!this.viewMap.has(id)) {
            return;
        }
        this._activeView = id;
        for (const [vid, { btn, view }] of this.viewMap) {
            const active = vid === id;
            view.hidden = !active;
            btn.classList.toggle("active", active);
            btn.setAttribute("aria-pressed", String(active));
        }
        this.dispatchEvent(new CustomEvent("viewchange", { detail: { view: id }, bubbles: true }));
    }

    /** The content container for a view, or null if unknown. */
    getView(id: string): HTMLElement | null {
        this.ensureSetup();
        return this.viewMap.get(id)?.view ?? null;
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
