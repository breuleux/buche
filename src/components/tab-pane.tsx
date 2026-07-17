// A set of panes with a tab bar on top: `<tab-pane>`.
//
//   const tp = document.createElement("tab-pane") as TabPane;
//   const sh = new Echo({ from: ["$sh"], label: "sh", color: "green" });
//   tp.addTab(sh, shContent);
//   tp.addTab(new Echo({ from: ["$py"], label: "py", color: "blue" }), pyContent);
//   container.appendChild(tp);
//
// Each tab is configured from an {@link Echo}: its `label` is the tab text, its
// `color` (an Accent, interpreted by the color grammar in ../color.ts) is the
// underline shown when the tab is selected, its `status` drives a status dot, and
// its `views` set drives a row of view icons. Every tab also has an ✕ close
// button. Only the active pane's content is visible; click a tab to switch.
//
//   ┌──────────────────────────────────────────────────┐
//   │ ● shell ▤◧✕   ● python ◧✕     ← tab bar            │
//   │ ▔▔▔▔▔▔▔▔▔▔▔▔                  (accent under active) │
//   ├────────────────────────────────────────────────── ┤
//   │ the active pane's content                          │
//   └──────────────────────────────────────────────────┘
//
// The Echo itself is the tab's identity — entries are keyed by the Echo object in
// a Map, so `showTab`, `removeTab`, etc. take the Echo you added. Adding a tab
// registers a reconfiguration listener on `echo.listeners`; mutate the Echo and
// call `echo.fire()` and the tab re-reads its label, accent, status and views.
//
// A dim line runs along the bottom of the tab bar; under the selected tab that
// line takes on the tab's accent color (reproducing the zone-tab look from the
// original buche styles.css).
//
// `<tab-pane hide-single>` hides the tab bar while there is at most one tab.
//
// Events (all bubble):
//   "tabchange"  detail: { echo: Echo }               — the active tab changed
//   "tabclose"   detail: { echo: Echo }               — a tab's ✕ was clicked
//   "viewselect" detail: { echo: Echo, view: ViewLabel } — a view icon was clicked
//
// Appearance lives in the companion stylesheet `tab-pane.css` (or the
// consolidated components.css).

import type { DomProps } from "myjsx/jsx-runtime";
import { defaultTheme, type Theme } from "../color.ts";
import { Echo, type ViewLabel } from "../echo.ts";
import { VIEW_ICONS, VIEW_TITLES } from "./echo-box.tsx";

interface Entry {
    echo: Echo;
    tab: HTMLElement;
    labelEl: HTMLElement;
    statusEl: HTMLElement;
    viewsEl: HTMLElement;
    pane: HTMLElement;
    /** The reconfiguration callback registered on `echo.listeners`. */
    listener: (echo: Echo) => void;
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
    // Tabs are keyed by their Echo object — the Echo is the tab's identity.
    private entries = new Map<Echo, Entry>();
    private order: Echo[] = [];
    private active: Echo | null = null;

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

        // Capture authored `[data-label]` children as panes before we rebuild,
        // wrapping each in a fresh Echo.
        const authored = Array.from(this.children).filter(
            (c): c is HTMLElement => c instanceof HTMLElement && c.hasAttribute("data-label"),
        );
        this.replaceChildren();

        this.tabsEl = document.createElement("div");
        this.tabsEl.className = "tab-pane-tabs";
        this.bodyEl = document.createElement("div");
        this.bodyEl.className = "tab-pane-body";
        this.append(this.tabsEl, this.bodyEl);

        for (const child of authored) {
            const content = document.createElement("div");
            content.append(...Array.from(child.childNodes));
            const echo = new Echo({
                from: ["$tab-pane"],
                label: child.getAttribute("data-label") ?? "",
                color: child.getAttribute("data-color") ?? undefined,
            });
            this.addTab(echo, content);
        }
    }

    /** The tab echoes, in order. */
    get tabs(): Echo[] {
        this.ensureSetup();
        return [...this.order];
    }

    /** The active tab's echo, or null when there are no tabs. */
    get activeTab(): Echo | null {
        this.ensureSetup();
        return this.active;
    }

    /** Add a tab (and its pane) for `echo`. Returns the same Echo, which is the
     *  tab's handle for {@link showTab} / {@link removeTab} / {@link paneFor}. */
    addTab(echo: Echo, content?: HTMLElement): Echo {
        this.ensureSetup();
        if (this.entries.has(echo)) {
            return echo;
        }

        // A tab is a flex row: status dot · label · view icons · ✕. It is a div
        // (not a button) so the view/close buttons can nest inside it.
        const tab = document.createElement("div");
        tab.className = "tab-pane-tab";
        tab.setAttribute("role", "tab");
        tab.tabIndex = 0;
        tab.addEventListener("click", () => this.showTab(echo));
        tab.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                this.showTab(echo);
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
            this.dispatchEvent(new CustomEvent("tabclose", { detail: { echo }, bubbles: true }));
        });

        tab.append(statusEl, labelEl, viewsEl, closeEl);

        const pane = document.createElement("div");
        pane.className = "tab-pane-pane";
        if (content) {
            pane.appendChild(content);
        }

        // Re-read the tab whenever the Echo is reconfigured (echo.fire()).
        const listener = (): void => this.reconfigure(echo);
        echo.listeners.push(listener);

        const entry: Entry = { echo, tab, labelEl, statusEl, viewsEl, pane, listener };
        this.entries.set(echo, entry);
        this.order.push(echo);
        this.tabsEl.appendChild(tab);
        this.bodyEl.appendChild(pane);
        this.renderTab(entry);
        this.applyUnderline(entry);

        if (this.active === null) {
            this.showTab(echo);
        } else {
            pane.style.display = "none";
        }
        this.updateTabsVisibility();
        return echo;
    }

    /** Remove a tab and its pane, and detach its reconfiguration listener. */
    removeTab(echo: Echo): void {
        this.ensureSetup();
        const entry = this.entries.get(echo);
        if (!entry) {
            return;
        }
        echo.listeners = echo.listeners.filter((l) => l !== entry.listener);
        entry.tab.remove();
        entry.pane.remove();
        this.entries.delete(echo);
        this.order = this.order.filter((x) => x !== echo);
        if (this.active === echo) {
            this.active = null;
            const next = this.order[0];
            if (next) {
                this.showTab(next);
            }
        }
        this.updateTabsVisibility();
    }

    /** Make a tab (and its pane) the active one. */
    showTab(echo: Echo): void {
        this.ensureSetup();
        const entry = this.entries.get(echo);
        if (!entry || this.active === echo) {
            return;
        }
        const prev = this.active !== null ? this.entries.get(this.active) : undefined;
        // Update `active` first so applyUnderline(prev) sees prev as inactive and
        // clears its underline.
        this.active = echo;
        if (prev) {
            prev.tab.classList.remove("active");
            prev.pane.style.display = "none";
            this.applyUnderline(prev);
        }
        entry.tab.classList.add("active");
        entry.pane.style.display = "";
        this.applyUnderline(entry);
        this.dispatchEvent(new CustomEvent("tabchange", { detail: { echo }, bubbles: true }));
    }

    /** The pane element for a tab, so callers can fill it with content. */
    paneFor(echo: Echo): HTMLElement | null {
        this.ensureSetup();
        return this.entries.get(echo)?.pane ?? null;
    }

    // Re-read an Echo's label, status, views and accent after it was reconfigured.
    private reconfigure(echo: Echo): void {
        const entry = this.entries.get(echo);
        if (!entry) {
            return;
        }
        this.renderTab(entry);
        this.applyUnderline(entry);
    }

    // Resolve an Echo's accent to a concrete CSS color (empty when unparseable).
    private accentColor(echo: Echo): string {
        if (!echo.color) {
            return "";
        }
        try {
            return this.theme.calculateStyle(echo.color).color ?? "";
        } catch {
            return "";
        }
    }

    // Render the tab's content: label, status dot, view icons and accent. The
    // status is reflected onto `data-status`; the accent is exposed as the
    // `--tab-accent` custom property (used by the status dot).
    private renderTab(entry: Entry): void {
        const { echo, tab, labelEl, viewsEl } = entry;
        labelEl.textContent = echo.label;
        tab.setAttribute("data-status", echo.status?.status ?? "absent");

        const accent = this.accentColor(echo);
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
                viewsEl.appendChild(this.makeViewButton(echo, lbl));
            }
        }
    }

    private makeViewButton(echo: Echo, lbl: ViewLabel): HTMLButtonElement {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "tab-pane-view-btn";
        btn.setAttribute("data-view", lbl);
        btn.textContent = VIEW_ICONS[lbl];
        btn.title = VIEW_TITLES[lbl];
        btn.setAttribute("aria-label", btn.title);
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            this.showTab(echo);
            this.dispatchEvent(
                new CustomEvent("viewselect", { detail: { echo, view: lbl }, bubbles: true }),
            );
        });
        return btn;
    }

    // Underline color: the accent while active, transparent otherwise. The dim
    // baseline lives on `.tab-pane-tabs`; the active tab paints over it.
    private applyUnderline(entry: Entry): void {
        if (entry.echo !== this.active) {
            entry.tab.style.removeProperty("border-bottom-color");
            return;
        }
        const accent = this.accentColor(entry.echo);
        if (accent) {
            entry.tab.style.setProperty("border-bottom-color", accent);
        } else {
            entry.tab.style.removeProperty("border-bottom-color");
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
