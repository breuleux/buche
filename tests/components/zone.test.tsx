// @vitest-environment happy-dom

import { afterEach, describe, expect, test } from "vitest";
import type { TabbedZoneElement } from "../../src/components/zone.tsx";
import "../../src/components/zone.tsx";
import { Entry } from "../../src/entry.ts";

afterEach(() => {
    document.body.replaceChildren();
});

describe("tabbed-zone — emptiness", () => {
    test("an empty zone is hidden; a tab shows it again", () => {
        const zone = document.createElement("tabbed-zone") as TabbedZoneElement;
        document.body.appendChild(zone);
        expect(zone.hidden).toBe(true);

        const entry = new Entry({});
        entry.echo.label = "a";
        zone.tabs.addTab(entry, document.createElement("div"));
        expect(zone.hidden).toBe(false);

        zone.tabs.removeTab(entry);
        expect(zone.hidden).toBe(true);
    });
});

// ── PopZone ─────────────────────────────────────────────────────────────────

import type { EchoBox } from "../../src/components/echo-box.tsx";
import type { BucheInterface } from "../../src/interface.tsx";
import { PopZone } from "../../src/zone.ts";

interface FakeIfc {
    pushed: any[];
    focused: (HTMLElement | null)[];
    interactions: { push: (m: any) => void };
    focus: {
        root: HTMLElement;
        focus: (el: HTMLElement, source: string) => void;
        commitFocus: () => void;
        holdCommits: boolean;
    };
    focusPrompt: () => void;
}

function fakeIfc(root: HTMLElement): FakeIfc {
    const pushed: any[] = [];
    const focused: (HTMLElement | null)[] = [];
    return {
        pushed,
        focused,
        interactions: { push: (m: any) => pushed.push(m) },
        focus: {
            root,
            focus: (el: HTMLElement) => focused.push(el),
            commitFocus: () => {},
            holdCommits: false,
        },
        focusPrompt: () => focused.push(null),
    };
}

// A slot, plus the element standing in for the focus manager's root (the
// PopZone listens for "focus-change" there, as the real one dispatches it).
function popInSlot(): { slot: HTMLElement; pop: PopZone; ifc: FakeIfc } {
    const root = document.createElement("div");
    const slot = document.createElement("div");
    root.append(slot);
    document.body.append(root);
    return { slot, pop: new PopZone({ names: ["pop"], element: slot }), ifc: fakeIfc(root) };
}

describe("pop-zone", () => {
    test("holds a single compact cell; a new install closes the previous one", () => {
        const { slot, pop, ifc } = popInSlot();
        const e1 = new Entry({});
        const box1 = pop.installCell(ifc as any, e1) as EchoBox;
        expect(slot.children).toHaveLength(1);
        expect(box1.compact).toBe(true);

        const e2 = new Entry({});
        const box2 = pop.installCell(ifc as any, e2);
        expect(slot.children).toHaveLength(1);
        expect(slot.firstElementChild).toBe(box2);
        expect(box1.isConnected).toBe(false);
        expect(ifc.pushed.some((m) => m.type === "user_signal" && m.entry === e1)).toBe(true);
    });

    test("closing the box (✕) signals and empties the slot", () => {
        const { slot, pop, ifc } = popInSlot();
        const entry = new Entry({});
        const box = pop.installCell(ifc as any, entry) as EchoBox;
        box.dispatchEvent(new CustomEvent("close", { bubbles: true }));
        expect(box.isConnected).toBe(false);
        expect(slot.children).toHaveLength(0);
        expect(ifc.pushed.some((m) => m.type === "user_signal" && m.entry === entry)).toBe(true);
    });

    test("focus leaving the cell closes it; focus moving inside does not", () => {
        const { slot, pop, ifc } = popInSlot();
        const entry = new Entry({});
        const box = pop.installCell(ifc as any, entry) as EchoBox;

        const inner = document.createElement("div");
        box.append(inner);
        ifc.focus.root.dispatchEvent(
            new CustomEvent("focus-change", {
                detail: { previous: box, current: inner },
                bubbles: true,
            }),
        );
        expect(box.isConnected).toBe(true);

        ifc.focus.root.dispatchEvent(
            new CustomEvent("focus-change", {
                detail: { previous: inner, current: null },
                bubbles: true,
            }),
        );
        expect(box.isConnected).toBe(false);
        expect(slot.children).toHaveLength(0);
        expect(ifc.pushed.some((m) => m.type === "user_signal" && m.entry === entry)).toBe(true);
    });

    test("a spent pop holds the focus; Esc sends it back to the prompt", () => {
        const { pop, ifc } = popInSlot();
        const entry = new Entry({});
        const box = pop.installCell(ifc as any, entry) as EchoBox;
        // Ends without the interface releasing the ended cell's focus.
        expect(entry.echo.sticky).toBe(true);

        // Running: Esc belongs to the app, the focus stays put.
        box.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        expect(ifc.focused).toHaveLength(0);

        // Done: Esc refocuses (the prompt row, or the latest prompt).
        box.status = "done";
        box.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        expect(ifc.focused).toHaveLength(1);
        expect(ifc.focused[0]).toBeNull(); // no row wired: the fallback prompt
    });
});
