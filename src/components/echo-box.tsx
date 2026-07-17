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
// Events (both bubble):
//   "viewchange"  detail: { view: string }   — the active view changed
//   "close"                                   — the closing icon was clicked
//
// Appearance lives in the companion stylesheet `echo-box.css` (or the
// consolidated components.css).

import type { DomProps } from "myjsx/jsx-runtime";

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
    private initialized = false;
    private gutter!: HTMLElement;
    private statusEl!: HTMLElement;
    private echoEl!: HTMLElement;
    private controlsEl!: HTMLElement;
    private cellEl!: HTMLElement;
    private closeEl!: HTMLButtonElement;
    private viewMap = new Map<string, { btn: HTMLButtonElement; view: HTMLElement }>();
    private _activeView: string | null = null;
    private _status: EchoStatus = "running";

    static get observedAttributes(): string[] {
        return ["status", "color", "echo"];
    }

    connectedCallback(): void {
        this.ensureSetup();
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
        this.gutter = div("echo-box-gutter");
        this.statusEl = div("echo-box-status");
        this.gutter.append(this.statusEl);

        // Header: echo text + controls (view icons, then the closing icon).
        this.echoEl = div("echo-box-echo");
        this.controlsEl = div("echo-box-controls");
        this.closeEl = document.createElement("button");
        this.closeEl.type = "button";
        this.closeEl.className = "echo-box-close";
        this.closeEl.textContent = "✕";
        this.closeEl.addEventListener("click", (e) => {
            e.stopPropagation();
            this.dispatchEvent(new CustomEvent("close", { bubbles: true }));
        });
        this.controlsEl.append(this.closeEl);

        const header = div("echo-box-header");
        header.append(this.echoEl, this.controlsEl);

        // Cell: holds the views; only the active one is shown.
        this.cellEl = div("echo-box-cell");

        const body = div("echo-box-body");
        body.append(header, this.cellEl);

        this.append(this.gutter, body);

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

    // ── Echo (the submitted command line) ─────────────────────────────────────

    get echo(): string {
        this.ensureSetup();
        return this.echoEl.textContent ?? "";
    }

    set echo(value: string) {
        this.setEcho(value);
    }

    /** Set the echo to plain text or a rich node (e.g. a highlighted command). */
    setEcho(content: string | Node): void {
        this.ensureSetup();
        if (typeof content === "string") {
            this.echoEl.textContent = content;
        } else {
            this.echoEl.replaceChildren(content);
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
