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

    // MutationObserver callbacks run at a microtask checkpoint.
    async function settled() {
        await Promise.resolve();
    }

    test("dragging a collapsed pane's border reveals it and grows it", async () => {
        const panes = (Array.from(grid.children) as HTMLElement[]).filter(
            (c) => !c.className.includes("grid-divider"),
        );
        panes[1].hidden = true;
        await settled();
        // Grabbing B's border reveals the empty pane (from zero) and the drag
        // grows it out of its neighbour C: flexPx = 300 - 2*4 dividers, so the
        // 73px come straight off C, leaving A's half untouched.
        drag(1, 73);
        await settled();
        expect(panes[1].hidden).toBe(false);
        const fr = firstPart(grid.style.gridTemplateRows)
            .filter((p) => p.endsWith("fr"))
            .map((p) => Number.parseFloat(p));
        expect(fr[0]).toBeCloseTo(0.5, 5);
        expect(fr[1]).toBeCloseTo(73 / 292, 5);
        expect(fr[2]).toBeCloseTo(0.5 - 73 / 292, 5);
    });

    test("a hidden pane takes no track but keeps its borders draggable", async () => {
        const panes = () =>
            (Array.from(grid.children) as HTMLElement[]).filter(
                (c) => !c.className.includes("grid-divider"),
            );
        const dividers = () =>
            (Array.from(grid.children) as HTMLElement[]).filter((c) =>
                c.className.includes("grid-divider"),
            );
        panes()[1].hidden = true;
        await settled();
        // Both borders of the collapsed run stay visible and draggable.
        expect(dividers().filter((d) => !d.hidden).length).toBe(2);
        const parts = firstPart(grid.style.gridTemplateRows);
        expect(parts.filter((p) => p.endsWith("fr")).length).toBe(2);
        expect(parts.filter((p) => p === "4px").length).toBe(2);
        // The visible fractions are renormalised to sum to 1 (an `fr` sum
        // below 1 would leave the difference undistributed).
        expect(parts).toEqual(["0.5fr", "4px", "4px", "0.5fr"]);
    });

    test("a divider hides only when both its neighbours collapse", async () => {
        const panes = Array.from(grid.children).filter(
            (c) => !c.className.includes("grid-divider"),
        ) as HTMLElement[];
        const dividers = Array.from(grid.querySelectorAll<HTMLElement>(".grid-divider-row"));
        const shown = () => dividers.filter((d) => !d.hidden).length;
        // Hide the first pane: its border with B stays (draggable, and B can
        // still claim a share of the visible area through it).
        panes[0].hidden = true;
        await settled();
        expect(shown()).toBe(2);
        // Collapse the run up to C as well: only the divider against C remains.
        panes[1].hidden = true;
        await settled();
        expect(shown()).toBe(1);
        // C is the only visible pane: it claims all the space after its border.
        expect(grid.style.gridTemplateRows).toBe("4px 1fr");
        // Hide everything: no dividers, no tracks.
        panes[2].hidden = true;
        await settled();
        expect(shown()).toBe(0);
        expect(grid.style.gridTemplateRows).toBe("");
        // Show them all again: the full layout is restored.
        for (const p of panes) {
            p.hidden = false;
        }
        await settled();
        expect(shown()).toBe(2);
        expect(firstPart(grid.style.gridTemplateRows).filter((p) => p.endsWith("fr")).length).toBe(
            3,
        );
    });

    test("grid-columns uses col-resize dividers", () => {
        const cols = document.createElement("grid-columns");
        cols.append(document.createElement("div"), document.createElement("div"));
        document.body.append(cols);
        expect(cols.querySelectorAll(".grid-divider-col").length).toBe(1);
        expect(cols.style.gridTemplateColumns).toContain("fr");
    });
});
