// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import "../../src/components/grid.tsx";

afterEach(() => {
    document.body.replaceChildren();
});

// happy-dom reports 0 for clientHeight/clientWidth, so stub the drag-axis extent
// used by the resize math to a known value.
function stubExtent(el: HTMLElement, prop: "clientHeight" | "clientWidth", px: number) {
    Object.defineProperty(el, prop, { configurable: true, value: px });
}

function firstPart(template: string) {
    return template.split(" ");
}

describe("grid-rows / grid-columns", () => {
    let grid: HTMLElement;

    beforeEach(() => {
        grid = document.createElement("grid-rows");
        grid.append(
            (() => {
                const d = document.createElement("div");
                d.textContent = "A";
                return d;
            })(),
            (() => {
                const d = document.createElement("div");
                d.textContent = "B";
                return d;
            })(),
            (() => {
                const d = document.createElement("div");
                d.textContent = "C";
                return d;
            })(),
        );
        document.body.append(grid);
    });

    test("inserts one divider between each pair of panes", () => {
        const dividers = grid.querySelectorAll(".grid-divider-row");
        expect(dividers.length).toBe(2);
        // Layout order: pane, divider, pane, divider, pane.
        const classes = Array.from(grid.children).map((c) =>
            c.className.includes("grid-divider") ? "div" : "pane",
        );
        expect(classes).toEqual(["pane", "div", "pane", "div", "pane"]);
    });

    test("starts with equal fractions", () => {
        const parts = firstPart(grid.style.gridTemplateRows);
        // 0.333..fr 4px 0.333..fr 4px 0.333..fr
        expect(parts.filter((p) => p.endsWith("fr")).length).toBe(3);
        expect(parts.filter((p) => p === "4px").length).toBe(2);
    });

    function drag(dividerIndex: number, deltaPx: number) {
        const divider = grid.querySelectorAll<HTMLElement>(".grid-divider-row")[dividerIndex];
        // Give the container a measurable size for the fraction math.
        stubExtent(grid, "clientHeight", 300);
        // 300 total - 2*4px dividers = 292 flexible px.
        divider.setPointerCapture = () => {};
        divider.releasePointerCapture = () => {};
        divider.dispatchEvent(new PointerEvent("pointerdown", { clientY: 100 }));
        divider.dispatchEvent(new PointerEvent("pointermove", { clientY: 100 + deltaPx }));
        divider.dispatchEvent(new PointerEvent("pointerup", { clientY: 100 + deltaPx }));
    }

    function fractions() {
        return firstPart(grid.style.gridTemplateRows)
            .filter((p) => p.endsWith("fr"))
            .map((p) => Number.parseFloat(p));
    }

    test("dragging the first divider only resizes its two neighbours", () => {
        const before = fractions();
        drag(0, 73); // +73px of 292 flexible px = +0.25 fraction
        const after = fractions();
        expect(after[0]).toBeCloseTo(before[0] + 0.25, 5);
        expect(after[1]).toBeCloseTo(before[1] - 0.25, 5);
        // Third pane untouched — the second divider did not move.
        expect(after[2]).toBeCloseTo(before[2], 5);
    });

    test("a divider stops at the next one (cannot push past it)", () => {
        // Drag the first divider far downward — pane B (index 1) can shrink to 0
        // but no further, so pane C stays fixed.
        drag(0, 100000);
        const after = fractions();
        expect(after[1]).toBeCloseTo(0, 5);
        expect(after[0]).toBeCloseTo(2 / 3, 5); // absorbed B's share
        expect(after[2]).toBeCloseTo(1 / 3, 5); // untouched
    });

    test("dragging announces the new geometry with a bubbling grid-resize", () => {
        let fired = 0;
        document.body.addEventListener("grid-resize", () => fired++);
        drag(0, 20);
        expect(fired).toBeGreaterThanOrEqual(1);
    });

    test("grid-columns uses col-resize dividers", () => {
        const cols = document.createElement("grid-columns");
        cols.append(document.createElement("div"), document.createElement("div"));
        document.body.append(cols);
        expect(cols.querySelectorAll(".grid-divider-col").length).toBe(1);
        expect(cols.style.gridTemplateColumns).toContain("fr");
    });
});
