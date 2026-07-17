// @vitest-environment happy-dom

import { afterEach, describe, expect, test } from "vitest";
import type { BasicAnsi } from "../../src/components/basic-ansi.tsx";
import type { BasicTerm } from "../../src/components/basic-term.tsx";
import "../../src/components/basic-term.tsx";

afterEach(() => {
    document.body.replaceChildren();
});

// Attributes are read on connect, so set them before appending.
function make(attrs: Record<string, string> = {}): BasicTerm {
    const el = document.createElement("basic-term") as BasicTerm;
    for (const [k, v] of Object.entries(attrs)) {
        el.setAttribute(k, v);
    }
    document.body.append(el);
    return el;
}

const regions = (t: BasicTerm): BasicAnsi[] =>
    Array.from(t.querySelectorAll("basic-ansi")) as unknown as BasicAnsi[];

const sepLabel = (t: BasicTerm): string | null =>
    t.querySelector(".basic-term-separator-label")?.textContent ?? null;

const textLines = (el: Element): string[] =>
    (el.textContent ?? "").split("\n").filter((s) => s.length > 0);

describe("basic-term — structure", () => {
    test("starts with a scroll-fader and a single head region, no separator", () => {
        const t = make();
        expect(t.querySelectorAll("scroll-fader").length).toBe(1);
        expect(regions(t).length).toBe(1);
        expect(t.querySelector(".basic-term-separator")).toBeNull();
    });

    test("seals the head at the default line budget (100)", () => {
        const t = make();
        for (let i = 0; i < 100; i++) {
            t.write("x\n");
        }
        expect(regions(t).length).toBe(2); // head sealed, tail created
        expect(regions(t)[0].lineCount).toBe(100);
    });
});

describe("basic-term — windowing", () => {
    test("keeps the first N and last M lines, dropping the middle", () => {
        const t = make({ "initial-lines": "5", "keep-lines": "10" });
        for (let i = 1; i <= 1000; i++) {
            t.write(`line ${i}\n`);
        }
        const [head, tail] = regions(t);
        expect(regions(t).length).toBe(2);
        expect(textLines(head)).toEqual(["line 1", "line 2", "line 3", "line 4", "line 5"]);

        const tail_ = textLines(tail);
        expect(tail_.length).toBe(10);
        expect(tail_[0]).toBe("line 991");
        expect(tail_.at(-1)).toBe("line 1000");
    });

    test("the separator reports how much was dropped", () => {
        const t = make({ "initial-lines": "5", "keep-lines": "10" });
        for (let i = 1; i <= 1000; i++) {
            t.write(`line ${i}\n`);
        }
        // 1000 − 5 head − 10 tail = 985.
        expect(sepLabel(t)).toContain("985 lines");
    });

    test("windows a single huge block written at once", () => {
        const t = make({ "initial-lines": "3", "keep-lines": "4" });
        let s = "";
        for (let i = 1; i <= 5000; i++) {
            s += `row ${i}\n`;
        }
        t.write(s);
        const [head, tail] = regions(t);
        expect(textLines(head)).toEqual(["row 1", "row 2", "row 3"]);
        const tail_ = textLines(tail);
        expect(tail_.length).toBe(4);
        expect(tail_.at(-1)).toBe("row 5000");
    });

    test("the byte budget can seal the head before the line budget", () => {
        // Big line budget, tiny byte budget: bytes bind first. Use newline-free
        // content so the byte count is unambiguous.
        const t = make({ "initial-lines": "1000", "initial-bytes": "10", "keep-lines": "5" });
        t.write("abcdefghijklmnop"); // 16 chars, no newline → head seals at 10
        expect(regions(t).length).toBe(2);
        expect(regions(t)[0].byteLength).toBe(10);
    });
});

describe("basic-term — giant line", () => {
    test("a 1 MB newline-less line stays bounded by the byte budgets", () => {
        const t = make({ "initial-lines": "5", "keep-lines": "10" }); // 750 + 1500 bytes
        t.write(`${"X".repeat(1_000_000)}\n`);
        const xcount =
            (t.textContent ?? "").length - (t.textContent ?? "").replace(/X/g, "").length;
        expect(xcount).toBeGreaterThan(0);
        expect(xcount).toBeLessThanOrEqual(750 + 1500 + 16); // head + tail budgets (+ slack)
    });
});

describe("basic-term — cursor and clear", () => {
    test("after sealing, the cursor lives in the tail; the head is frozen", () => {
        const t = make({ "initial-lines": "2", "keep-lines": "5" });
        for (let i = 1; i <= 20; i++) {
            t.write(`l${i}\n`);
        }
        const [head, tail] = regions(t);
        expect(head.querySelectorAll(".cursor").length).toBe(0);
        expect(tail.querySelectorAll(".cursor").length).toBe(1);
    });

    test("clear() resets to a single empty head region", () => {
        const t = make({ "initial-lines": "2", "keep-lines": "3" });
        for (let i = 1; i <= 50; i++) {
            t.write(`n${i}\n`);
        }
        expect(regions(t).length).toBe(2);
        t.clear();
        expect(regions(t).length).toBe(1);
        expect(t.querySelector(".basic-term-separator")).toBeNull();
        expect(regions(t)[0].textContent).toBe("");
    });
});
