// @vitest-environment happy-dom

import { afterEach, describe, expect, test } from "vitest";
import type { TabPane } from "../../src/components/tab-pane.tsx";
import "../../src/components/tab-pane.tsx";
import { Entry } from "../../src/entry.ts";

afterEach(() => {
    document.body.replaceChildren();
});

function make(): TabPane {
    const tp = document.createElement("tab-pane") as TabPane;
    document.body.appendChild(tp);
    return tp;
}

function add(tp: TabPane, label: string): Entry {
    const entry = new Entry({});
    entry.echo.label = label;
    tp.addTab(entry, document.createElement("div"));
    return entry;
}

describe("tab-pane — removing", () => {
    test("removing the active tab reverts to the previously active one", () => {
        const tp = make();
        const a = add(tp, "a");
        const b = add(tp, "b");
        const c = add(tp, "c");
        tp.showTab(c);
        tp.showTab(b);

        tp.removeTab(b);
        expect(tp.activeTab).toBe(c);
        expect(tp.paneFor(c)?.style.display).toBe("");

        tp.removeTab(c);
        expect(tp.activeTab).toBe(a);
    });

    test("falls back to the first tab when no previously active one remains", () => {
        const tp = make();
        const a = add(tp, "a"); // active: added first
        const b = add(tp, "b");
        add(tp, "c");
        tp.removeTab(a);
        expect(tp.activeTab).toBe(b);
    });

    test("removing an inactive tab keeps the active one", () => {
        const tp = make();
        const a = add(tp, "a");
        const b = add(tp, "b");
        tp.showTab(b);
        tp.removeTab(a);
        expect(tp.activeTab).toBe(b);
    });
});

describe("tab-pane — status", () => {
    test("status dots get a shared animation phase, stamped only on change", () => {
        const tp = make();
        const entry = new Entry({});
        tp.addTab(entry, document.createElement("div"));
        const tab = tp.querySelector<HTMLElement>(".tab-pane-tab")!;
        expect(tab.getAttribute("data-status")).toBe("absent");
        expect(tab.style.getPropertyValue("--status-throb-phase")).toMatch(/^-\d+ms$/);
        expect(tab.style.getPropertyValue("--status-blink-phase")).toMatch(/^-\d+ms$/);

        entry.echo.status = { status: "running" };
        entry.fire();
        expect(tab.getAttribute("data-status")).toBe("running");

        // Unrelated reconfigurations must not re-stamp (and twitch) the phase.
        const phased = tab.style.getPropertyValue("--status-throb-phase");
        entry.echo.label = "renamed";
        entry.fire();
        expect(tab.style.getPropertyValue("--status-throb-phase")).toBe(phased);
    });
});
