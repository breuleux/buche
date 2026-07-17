// A set of panes with a tab bar on top: `<tab-pane>`.
//
//   const tp = document.createElement("tab-pane") as TabPane;
//   tp.addTab({ label: "sh", color: "green" }, shContent);
//   tp.addTab({ label: "py", color: "blue" }, pyContent);
//   container.appendChild(tp);
//
// Each tab is configured from an {@link Echo}-shaped object: its `label` is the
// tab text and its `color` (an Accent, interpreted by the color grammar in
// ../color.ts) is the underline shown when the tab is selected. Only the active
// pane's content is visible; click a tab to switch.
//
//   ┌───────────────────────────────────────────┐
//   │ sh   py   notes            ← tab bar        │
//   │ ▔▔▔                        (accent under    │
//   ├─────────────────────────────  active tab)   ┤
//   │ the active pane's content                   │
//   └───────────────────────────────────────────┘
//
// A dim line runs along the bottom of the tab bar; under the selected tab that
// line takes on the tab's accent color (reproducing the zone-tab look from the
// original buche styles.css).
//
// This is deliberately standalone: it does not import the `Echo` class, it just
// accepts anything with `label` / `color` (which an `Echo` satisfies).
//
// Events (both bubble):
//   "tabchange"  detail: { tab: string }   — the active tab changed
//
// Appearance lives in the companion stylesheet `tab-pane.css` (or the
// consolidated components.css).

import type { DomProps } from "myjsx/jsx-runtime";
import { defaultTheme, type Theme } from "../color.ts";
import type { Accent } from "../types.ts";

/** The subset of an {@link Echo} used to configure a tab. */
export interface TabEcho {
    /** The tab's text. */
    label: string;
    /** Accent color for the underline while the tab is selected. */
    color?: Accent;
}

export interface TabConfig extends TabEcho {
    /** Optional explicit id; auto-generated when omitted. */
    id?: string;
    /** Optional content element for the pane. */
    content?: HTMLElement;
}

interface Entry {
    id: string;
    echo: TabEcho;
    tab: HTMLElement;
    pane: HTMLElement;
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
    private entries = new Map<string, Entry>();
    private order: string[] = [];
    private active: string | null = null;
    private counter = 0;

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

        // Capture authored `[data-label]` children as panes before we rebuild.
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
            this.addTab(
                {
                    label: child.getAttribute("data-label") ?? "",
                    color: child.getAttribute("data-color") ?? undefined,
                },
                content,
            );
        }
    }

    /** The tab ids, in order. */
    get tabs(): string[] {
        this.ensureSetup();
        return [...this.order];
    }

    /** The active tab id, or null when there are no tabs. */
    get activeTab(): string | null {
        this.ensureSetup();
        return this.active;
    }

    /** Add a tab (and its pane). Returns the tab id. */
    addTab(echo: TabEcho, content?: HTMLElement): string {
        this.ensureSetup();
        const id = `tab-${this.counter++}`;

        const tab = document.createElement("button");
        tab.type = "button";
        tab.className = "tab-pane-tab";
        tab.textContent = echo.label;
        tab.addEventListener("click", () => this.showTab(id));

        const pane = document.createElement("div");
        pane.className = "tab-pane-pane";
        if (content) {
            pane.appendChild(content);
        }

        const entry: Entry = { id, echo, tab, pane };
        this.entries.set(id, entry);
        this.order.push(id);
        this.tabsEl.appendChild(tab);
        this.bodyEl.appendChild(pane);
        this.applyTabStyle(entry);

        if (this.active === null) {
            this.showTab(id);
        } else {
            pane.style.display = "none";
        }
        this.updateTabsVisibility();
        return id;
    }

    /** Remove a tab and its pane. */
    removeTab(id: string): void {
        this.ensureSetup();
        const entry = this.entries.get(id);
        if (!entry) {
            return;
        }
        entry.tab.remove();
        entry.pane.remove();
        this.entries.delete(id);
        this.order = this.order.filter((x) => x !== id);
        if (this.active === id) {
            this.active = null;
            const next = this.order[0];
            if (next) {
                this.showTab(next);
            }
        }
        this.updateTabsVisibility();
    }

    // Hide the tab bar when `hide-single` is set and there is at most one tab.
    private updateTabsVisibility(): void {
        const hide = this.hasAttribute("hide-single") && this.order.length <= 1;
        this.tabsEl.style.display = hide ? "none" : "";
    }

    /** Make a tab (and its pane) the active one. */
    showTab(id: string): void {
        this.ensureSetup();
        const entry = this.entries.get(id);
        if (!entry || this.active === id) {
            return;
        }
        const prev = this.active !== null ? this.entries.get(this.active) : undefined;
        // Update `active` first so applyTabStyle(prev) sees prev as inactive and
        // clears its underline.
        this.active = id;
        if (prev) {
            prev.tab.classList.remove("active");
            prev.pane.style.display = "none";
            this.applyTabStyle(prev);
        }
        entry.tab.classList.add("active");
        entry.pane.style.display = "";
        this.applyTabStyle(entry);
        this.dispatchEvent(new CustomEvent("tabchange", { detail: { tab: id }, bubbles: true }));
    }

    /** Reconfigure a tab from a new echo (updates label and accent). */
    setEcho(id: string, echo: TabEcho): void {
        this.ensureSetup();
        const entry = this.entries.get(id);
        if (!entry) {
            return;
        }
        entry.echo = echo;
        entry.tab.textContent = echo.label;
        this.applyTabStyle(entry);
    }

    /** The pane element for a tab, so callers can fill it with content. */
    paneFor(id: string): HTMLElement | null {
        this.ensureSetup();
        return this.entries.get(id)?.pane ?? null;
    }

    // Underline color: the accent while active, transparent otherwise. The dim
    // baseline lives on `.tab-pane-tabs`; the active tab paints over it.
    private applyTabStyle(entry: Entry): void {
        if (entry.id !== this.active) {
            entry.tab.style.removeProperty("border-bottom-color");
            return;
        }
        let color = "";
        if (entry.echo.color) {
            try {
                color = this.theme.calculateStyle(entry.echo.color).color ?? "";
            } catch {
                color = "";
            }
        }
        if (color) {
            entry.tab.style.setProperty("border-bottom-color", color);
        } else {
            entry.tab.style.removeProperty("border-bottom-color");
        }
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
