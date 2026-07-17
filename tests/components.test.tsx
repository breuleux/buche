// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import "../src/components/grid.tsx";
import "../src/components/scroll-fader.tsx";

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
        // 0.333..fr 6px 0.333..fr 6px 0.333..fr
        expect(parts.filter((p) => p.endsWith("fr")).length).toBe(3);
        expect(parts.filter((p) => p === "6px").length).toBe(2);
    });

    function drag(dividerIndex: number, deltaPx: number) {
        const divider = grid.querySelectorAll<HTMLElement>(".grid-divider-row")[dividerIndex];
        // Give the container a measurable size for the fraction math.
        stubExtent(grid, "clientHeight", 300);
        // 300 total - 2*6px dividers = 288 flexible px.
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
        drag(0, 72); // +72px of 288 flexible px = +0.25 fraction
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

    test("grid-columns uses col-resize dividers", () => {
        const cols = document.createElement("grid-columns");
        cols.append(document.createElement("div"), document.createElement("div"));
        document.body.append(cols);
        expect(cols.querySelectorAll(".grid-divider-col").length).toBe(1);
        expect(cols.style.gridTemplateColumns).toContain("fr");
    });
});

describe("scroll-fader", () => {
    // happy-dom does no layout, so drive update() by stubbing the scroller's
    // scroll metrics and dispatching a scroll event.
    function stubScroll(
        fader: HTMLElement,
        m: { scrollTop: number; scrollHeight: number; clientHeight: number },
    ) {
        const scroller = fader.querySelector<HTMLElement>(".scroll-fader-inner")!;
        for (const [k, v] of Object.entries(m)) {
            Object.defineProperty(scroller, k, { configurable: true, value: v });
        }
        scroller.dispatchEvent(new Event("scroll"));
    }

    const shadows = (fader: HTMLElement) => ({
        top: fader.querySelector(".scroll-shadow-top")!.classList.contains("visible"),
        bottom: fader.querySelector(".scroll-shadow-bottom")!.classList.contains("visible"),
    });

    test("builds inner scroller, content wrapper and two shadows", () => {
        const fader = document.createElement("scroll-fader");
        document.body.append(fader);
        expect(fader.querySelectorAll(".scroll-fader-inner").length).toBe(1);
        expect(fader.querySelectorAll(".scroll-fader-content").length).toBe(1);
        expect(fader.querySelectorAll(".scroll-shadow").length).toBe(2);
    });

    test("relocates authored children into the content wrapper, and `.inner` targets it", () => {
        const fader = document.createElement("scroll-fader");
        const a = document.createElement("p");
        a.textContent = "authored";
        fader.append(a);
        document.body.append(fader);

        const content = fader.querySelector(".scroll-fader-content")!;
        expect(a.parentElement).toBe(content);
        // `.inner` is the append target for new content.
        const b = document.createElement("p");
        (fader as unknown as { inner: HTMLElement }).inner.appendChild(b);
        expect(b.parentElement).toBe(content);
    });

    test("at the bottom: only the top shadow shows", () => {
        const fader = document.createElement("scroll-fader");
        document.body.append(fader);
        // column-reverse reports scrollTop 0 at the bottom.
        stubScroll(fader, { scrollTop: 0, scrollHeight: 1000, clientHeight: 200 });
        expect(shadows(fader)).toEqual({ top: true, bottom: false });
    });

    test("scrolled to the top: only the bottom shadow shows", () => {
        const fader = document.createElement("scroll-fader");
        document.body.append(fader);
        stubScroll(fader, { scrollTop: -800, scrollHeight: 1000, clientHeight: 200 });
        expect(shadows(fader)).toEqual({ top: false, bottom: true });
    });

    test("content shorter than the viewport: no shadows", () => {
        const fader = document.createElement("scroll-fader");
        document.body.append(fader);
        stubScroll(fader, { scrollTop: 0, scrollHeight: 100, clientHeight: 200 });
        expect(shadows(fader)).toEqual({ top: false, bottom: false });
    });
});
