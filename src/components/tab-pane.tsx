// A set of panes with a tab bar on top: `<tab-pane>`.
//
//   const tp = document.createElement("tab-pane") as TabPane;
//   const sh = new Entry({});
//   sh.echo.label = "sh";
//   sh.echo.color = "green";
//   tp.addTab(sh, shContent);
//   container.appendChild(tp);
//
// Each tab is configured from an {@link Entry} and keyed by that Entry object —
// `showTab`, `removeTab`, etc. take the Entry you added. Its Echo's `label` is the
// tab text, its `color` (an Accent, interpreted by the color grammar in
// ../color.ts) is the underline shown when the tab is selected, its `status`
// drives a status dot, and its `views` set drives a row of view icons. Every tab
// also has an ✕ close button. Only the active pane's content is visible; click a
// tab to switch.
//
//   ┌──────────────────────────────────────────────────┐
//   │ ● shell ▤◧✕   ● python ◧✕     ← tab bar            │
//   │ ▔▔▔▔▔▔▔▔▔▔▔▔                  (accent under active) │
//   ├────────────────────────────────────────────────── ┤
//   │ the active pane's content                          │
//   └──────────────────────────────────────────────────┘
//
// Adding a tab registers a reconfiguration listener on `entry.listeners`; mutate
// the Entry and call `entry.fire()` and the tab re-reads its label, accent,
// status and views.
//
// A dim line runs along the bottom of the tab bar; under the selected tab that
// line takes on the tab's accent color (reproducing the zone-tab look from the
// original buche styles.css).
//
// `<tab-pane hide-single>` hides the tab bar while there is at most one tab.
//
// Events (all bubble):
//   "tabchange"  detail: { entry: Entry }                — the active tab changed
//   "tabclose"   detail: { entry: Entry }                — a tab's ✕ was clicked
//   "viewselect" detail: { entry: Entry, view: ViewLabel } — a view icon was clicked
//
// Appearance lives in the companion stylesheet `tab-pane.css` (or the
// consolidated components.css).

import type { DomProps } from "myjsx/jsx-runtime";
import { defaultTheme, type Theme } from "../color.ts";
import type { ViewLabel } from "../echo.ts";
import type { Entry } from "../entry.ts";
import { VIEW_ICONS, VIEW_TITLES } from "./echo-box.tsx";

interface Row {
    entry: Entry;
    tab: HTMLElement;
    labelEl: HTMLElement;
    statusEl: HTMLElement;
    viewsEl: HTMLElement;
    pane: HTMLElement;
    /** The reconfiguration callback registered on `entry.listeners`. */
    listener: (entry: Entry) => void;
}

export class TabPane extends HTMLElement {
    /**
     * Theme used to resolve a tab's accent into a concrete underline color.
     * Defaults to the shared theme.
     */
    theme: Theme = defaultTheme;

    private initialized = false;
    private tabsEl!: HTMLElement;
    private bodyEl!: HTMLElement;
    // Tabs are keyed by their Entry object — the Entry is the tab's identity.
    private rows = new Map<Entry, Row>();
    private order: Entry[] = [];
    private active: Entry | null = null;

    static get observedAttributes(): string[] {
        return ["hide-single"];
    }

    connectedCallback(): void {
        this.ensureSetup();
    }

    attributeChangedCallback(): void {
        this.ensureSetup();
        this.updateTabsVisibility();
    }

    private ensureSetup(): void {
        if (this.initialized) {
            return;
        }
        this.initialized = true;
        this.replaceChildren();

        this.tabsEl = document.createElement("div");
        this.tabsEl.className = "tab-pane-tabs";
        this.bodyEl = document.createElement("div");
        this.bodyEl.className = "tab-pane-body";
        this.append(this.tabsEl, this.bodyEl);
    }

    /** The tab entries, in order. */
    get tabs(): Entry[] {
        this.ensureSetup();
        return [...this.order];
    }

    /** The active tab's entry, or null when there are no tabs. */
    get activeTab(): Entry | null {
        this.ensureSetup();
        return this.active;
    }

    /** Add a tab (and its pane) for `entry`. Returns the same Entry, which is the
     *  tab's handle for {@link showTab} / {@link removeTab} / {@link paneFor}. */
    addTab(entry: Entry, content?: HTMLElement): Row {
        this.ensureSetup();
        if (this.rows.has(entry)) {
            return this.rows.get(entry)!;
        }

        // A tab is a flex row: status dot · label · view icons · ✕. It is a div
        // (not a button) so the view/close buttons can nest inside it.
        const tab = document.createElement("div");
        tab.className = "tab-pane-tab";
        tab.setAttribute("role", "tab");
        tab.tabIndex = 0;
        tab.addEventListener("click", () => this.showTab(entry));
        tab.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                this.showTab(entry);
            }
        });

        const statusEl = document.createElement("span");
        statusEl.className = "tab-pane-tab-status";

        const labelEl = document.createElement("span");
        labelEl.className = "tab-pane-tab-label";

        const viewsEl = document.createElement("span");
        viewsEl.className = "tab-pane-tab-views";

        const closeEl = document.createElement("button");
        closeEl.type = "button";
        closeEl.className = "tab-pane-tab-close";
        closeEl.textContent = "✕";
        closeEl.title = "Close";
        closeEl.setAttribute("aria-label", "Close");
        closeEl.addEventListener("click", (e) => {
            e.stopPropagation();
            this.dispatchEvent(new CustomEvent("tabclose", { detail: { entry }, bubbles: true }));
        });

        tab.append(statusEl, labelEl, viewsEl, closeEl);

        const pane = document.createElement("div");
        pane.className = "tab-pane-pane";
        if (content) {
            pane.appendChild(content);
        }

        // Re-read the tab whenever the Entry is reconfigured (entry.fire()).
        const listener = (): void => this.reconfigure(entry);
        entry.listeners.push(listener);

        const row: Row = { entry, tab, labelEl, statusEl, viewsEl, pane, listener };
        this.rows.set(entry, row);
        this.order.push(entry);
        this.tabsEl.appendChild(tab);
        this.bodyEl.appendChild(pane);
        this.renderTab(row);
        this.applyUnderline(row);

        if (this.active === null) {
            this.showTab(entry);
        } else {
            pane.style.display = "none";
        }
        this.updateTabsVisibility();
        return row;
    }

    /** Remove a tab and its pane, and detach its reconfiguration listener. */
    removeTab(entry: Entry): void {
        this.ensureSetup();
        const row = this.rows.get(entry);
        if (!row) {
            return;
        }
        entry.listeners = entry.listeners.filter((l) => l !== row.listener);
        row.tab.remove();
        row.pane.remove();
        this.rows.delete(entry);
        this.order = this.order.filter((x) => x !== entry);
        if (this.active === entry) {
            this.active = null;
            const next = this.order[0];
            if (next) {
                this.showTab(next);
            }
        }
        this.updateTabsVisibility();
    }

    /** Make a tab (and its pane) the active one. */
    showTab(entry: Entry): void {
        this.ensureSetup();
        const row = this.rows.get(entry);
        if (!row || this.active === entry) {
            return;
        }
        const prev = this.active !== null ? this.rows.get(this.active) : undefined;
        // Update `active` first so applyUnderline(prev) sees prev as inactive and
        // clears its underline.
        this.active = entry;
        if (prev) {
            prev.tab.classList.remove("active");
            prev.pane.style.display = "none";
            this.applyUnderline(prev);
        }
        row.tab.classList.add("active");
        row.pane.style.display = "";
        this.applyUnderline(row);
        this.dispatchEvent(new CustomEvent("tabchange", { detail: { entry }, bubbles: true }));
    }

    /** The pane element for a tab, so callers can fill it with content. */
    paneFor(entry: Entry): HTMLElement | null {
        this.ensureSetup();
        return this.rows.get(entry)?.pane ?? null;
    }

    // Re-read an Entry's label, status, views and accent after it was reconfigured.
    private reconfigure(entry: Entry): void {
        const row = this.rows.get(entry);
        if (!row) {
            return;
        }
        this.renderTab(row);
        this.applyUnderline(row);
    }

    // Resolve an Entry's accent to a concrete CSS color (empty when unparseable).
    private accentColor(entry: Entry): string {
        const color = entry.echo.color;
        if (!color) {
            return "";
        }
        try {
            return this.theme.calculateStyle(color).color ?? "";
        } catch {
            return "";
        }
    }

    // Render the tab's content: label, status dot, view icons and accent. The
    // status is reflected onto `data-status`; the accent is exposed as the
    // `--tab-accent` custom property (used by the status dot).
    private renderTab(row: Row): void {
        const { entry, tab, labelEl, viewsEl } = row;
        const echo = entry.echo;
        labelEl.textContent = echo.label;
        tab.setAttribute("data-status", echo.status?.status ?? "absent");

        const accent = this.accentColor(entry);
        if (accent) {
            tab.style.setProperty("--tab-accent", accent);
        } else {
            tab.style.removeProperty("--tab-accent");
        }

        // Rebuild the view icons from the echo's view set. With a single view
        // there is nothing to switch between, so show no icons.
        viewsEl.replaceChildren();
        if (echo.views && echo.views.size > 1) {
            for (const lbl of echo.views) {
                viewsEl.appendChild(this.makeViewButton(entry, lbl));
            }
        }
    }

    private makeViewButton(entry: Entry, lbl: ViewLabel): HTMLButtonElement {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "tab-pane-view-btn";
        btn.setAttribute("data-view", lbl);
        btn.textContent = VIEW_ICONS[lbl];
        btn.title = VIEW_TITLES[lbl];
        btn.setAttribute("aria-label", btn.title);
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            this.showTab(entry);
            this.dispatchEvent(
                new CustomEvent("viewselect", { detail: { entry, view: lbl }, bubbles: true }),
            );
        });
        return btn;
    }

    // Underline color: the accent while active, transparent otherwise. The dim
    // baseline lives on `.tab-pane-tabs`; the active tab paints over it.
    private applyUnderline(row: Row): void {
        if (row.entry !== this.active) {
            row.tab.style.removeProperty("border-bottom-color");
            return;
        }
        const accent = this.accentColor(row.entry);
        if (accent) {
            row.tab.style.setProperty("border-bottom-color", accent);
        } else {
            row.tab.style.removeProperty("border-bottom-color");
        }
    }

    // Hide the tab bar when `hide-single` is set and there is at most one tab.
    private updateTabsVisibility(): void {
        const hide = this.hasAttribute("hide-single") && this.order.length <= 1;
        this.tabsEl.style.display = hide ? "none" : "";
    }
}

if (typeof customElements !== "undefined") {
    if (!customElements.get("tab-pane")) {
        customElements.define("tab-pane", TabPane);
    }
}

declare module "myjsx/jsx-runtime" {
    namespace JSX {
        interface CustomElements {
            "tab-pane": DomProps<TabPane>;
        }
    }
}
