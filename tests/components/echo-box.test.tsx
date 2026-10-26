// @vitest-environment happy-dom

import { afterEach, describe, expect, test } from "vitest";
import type { EchoBox } from "../../src/components/echo-box.tsx";
import "../../src/components/echo-box.tsx";

afterEach(() => {
    document.body.replaceChildren();
});

function make(): EchoBox {
    const el = document.createElement("echo-box") as EchoBox;
    document.body.append(el);
    return el;
}

const q = (el: EchoBox, sel: string) => el.querySelector(sel);

describe("echo-box — structure", () => {
    test("is a focusable cell holding a cell element", () => {
        const box = make();
        expect(box.getAttribute("focusable")).toBe("cell");
        expect(box.tabIndex).toBe(-1);
        expect(box.children).toHaveLength(1);
        expect(q(box, ".echo-box-cell")).not.toBeNull();
    });
});

describe("echo-box — content", () => {
    test("setContent shows it in the cell, with no view icons", () => {
        const box = make();
        const p = document.createElement("p");
        box.setContent(p);
        expect(box.content).toBe(p);
        expect(q(box, ".echo-box-cell")?.firstElementChild).toBe(p);
        expect(q(box, ".echo-box-controls button:not(.echo-box-close)")).toBeNull();
    });

    test("setContent replaces what the box showed", () => {
        const box = make();
        box.setContent(document.createElement("p"));
        const b = document.createElement("p");
        box.setContent(b);
        expect(q(box, ".echo-box-cell")?.children.length).toBe(1);
        expect(box.content).toBe(b);
    });

    test("setContent asks the focus manager to commit again", () => {
        const box = make();
        let asked = 0;
        box.addEventListener("focus-commit-request", () => asked++);
        box.setContent(document.createElement("p"));
        expect(asked).toBe(1);
    });
});

describe("echo-box — size polling", () => {
    // happy-dom has no rAF pacing to speak of for tests; waiting a couple of
    // animation intervals lets the box's size poll tick.
    const frames = (ms: number) => new Promise((r) => setTimeout(r, ms));

    // A box whose cell reports the size its inline height says (happy-dom
    // otherwise measures nothing), so the size poll sees real geometry.
    function setup(startHeight: number) {
        const box = make();
        const cell = q(box, ".echo-box-cell") as HTMLElement;
        cell.style.height = `${startHeight}px`;
        Object.defineProperty(cell, "clientWidth", { configurable: true, get: () => 200 });
        Object.defineProperty(cell, "clientHeight", {
            configurable: true,
            get: () => Number.parseFloat(cell.style.height) || 0,
        });
        return { box, cell };
    }

    test("a size change is announced once, as the poll notices it", async () => {
        const { box, cell } = setup(100);
        await frames(50); // baseline only
        let fired = 0;
        box.addEventListener("resize", () => fired++);
        cell.style.height = "150px";
        await frames(50);
        expect(fired).toBe(1);
        await frames(50);
        expect(fired).toBe(1); // unchanged → quiet
    });

    test("a terminal settling its grid re-announces unchanged pixels", async () => {
        const { box, cell } = setup(100);
        const view = document.createElement("div");
        box.setContent(view);
        await frames(50); // baseline at 100; nothing announced
        let fired = 0;
        box.addEventListener("resize", () => fired++);
        view.dispatchEvent(new CustomEvent("term-resize", { bubbles: true }));
        await frames(50);
        expect(fired).toBe(1);
        expect(cell.style.height).toBe("100px"); // pixels never moved
        await frames(50);
        expect(fired).toBe(1); // one forced announcement, then quiet
    });
});
