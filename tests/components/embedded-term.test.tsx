// @vitest-environment happy-dom

import { afterEach, describe, expect, test } from "vitest";
import type { EmbeddedTerm } from "../../src/components/embedded-term.tsx";
import "../../src/components/embedded-term.tsx";

afterEach(() => {
    document.body.replaceChildren();
});

// Attributes are read on connect, so set them before appending.
function make(attrs: Record<string, string> = {}): EmbeddedTerm {
    const el = document.createElement("embedded-term") as EmbeddedTerm;
    for (const [k, v] of Object.entries(attrs)) {
        el.setAttribute(k, v);
    }
    document.body.append(el);
    return el;
}

// Reach past `private` for the state the mechanism is about.
type Guts = { usedRows: number; held: string; stubOn: boolean; writing: boolean };
const guts = (el: EmbeddedTerm): Guts => el as unknown as Guts;

// Writes are queued and the tail is decided in a write callback, so let them drain.
async function drain(el: EmbeddedTerm): Promise<void> {
    for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 5));
        if (!guts(el).writing) {
            return;
        }
    }
}

const rowText = (el: EmbeddedTerm, y: number): string => {
    const buf = el.terminal.buffer.active;
    return buf.getLine(buf.viewportY + y)?.translateToString(true) ?? "";
};

const rows = (el: EmbeddedTerm): string[] =>
    Array.from({ length: el.terminal.rows }, (_, y) => rowText(el, y));

describe("embedded-term — held newlines", () => {
    test("an untouched terminal shows nothing but the squashed cursor", async () => {
        const t = make({ "max-rows": "10" });
        await drain(t);
        expect(guts(t).usedRows).toBe(0);
        expect(guts(t).stubOn).toBe(true);
    });

    test("each trailing newline reveals exactly one row and holds", async () => {
        const t = make({ "max-rows": "10" });
        await drain(t);
        for (const expected of [1, 2, 3]) {
            t.write("\r\n");
            await drain(t);
            expect(guts(t).usedRows).toBe(expected);
            expect(guts(t).held).toBe("\n");
            expect(guts(t).stubOn).toBe(true);
        }
    });

    test("content releases the held newline and clears the squashed cursor", async () => {
        const t = make({ "max-rows": "10" });
        await drain(t);
        t.write("hello\r\n");
        await drain(t);
        expect(guts(t).held).toBe("\n");
        expect(guts(t).usedRows).toBe(1);

        t.write("world");
        await drain(t);
        expect(guts(t).held).toBe("");
        expect(guts(t).stubOn).toBe(false);
        expect(guts(t).usedRows).toBe(2);
        expect(rowText(t, 0)).toBe("hello");
        expect(rowText(t, 1)).toBe("world");
    });

    test("two blocks in a row leave no blank line between them", async () => {
        const t = make({ "max-rows": "10" });
        await drain(t);
        const block = () => `${(t.atLineStart ? "" : "\r\n") + ["a", "b", "c"].join("\r\n")}\r\n`;
        t.write(block());
        await drain(t);
        t.write(block());
        await drain(t);
        expect(rows(t).slice(0, 6)).toEqual(["a", "b", "c", "a", "b", "c"]);
        expect(guts(t).usedRows).toBe(6);
    });

    test("the cursor survives a screenful — nothing is blank, but a newline is pending", async () => {
        const t = make({ "max-rows": "10" });
        await drain(t);
        const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
        t.write(`${lines.join("\r\n")}\r\n`);
        await drain(t);
        expect(t.terminal.buffer.active.baseY).toBeGreaterThan(0);
        expect(rows(t).every((l) => l !== "")).toBe(true); // no blank row to infer from
        expect(guts(t).held).toBe("\n");
        expect(guts(t).stubOn).toBe(true);
        expect(guts(t).usedRows).toBe(10);
        expect(rowText(t, 9)).toBe("line 30");
    });

    test("a newline onto an already-revealed row is written, not held", async () => {
        const t = make({ "max-rows": "10" });
        await drain(t);
        t.write("a\r\nb\r\nc");
        await drain(t);
        expect(guts(t).usedRows).toBe(3);
        // Cursor back up to row 0, where the row below is already shown.
        t.write("\x1b[1;1H");
        await drain(t);
        t.write("\r\n");
        await drain(t);
        expect(guts(t).held).toBe("");
        expect(guts(t).stubOn).toBe(false);
    });
});

describe("embedded-term — resize watching", () => {
    function fakeResizeObserver() {
        const observed: unknown[] = [];
        const unobserved: unknown[] = [];
        const frames: (() => void)[] = [];
        let fire: (() => void) | null = null;
        class FakeRO {
            constructor(cb: () => void) {
                fire = cb;
            }
            observe(el: unknown) {
                observed.push(el);
            }
            unobserve(el: unknown) {
                unobserved.push(el);
            }
            disconnect() {}
        }
        const realRO = globalThis.ResizeObserver;
        const realRaf = globalThis.requestAnimationFrame;
        globalThis.ResizeObserver = FakeRO as unknown as typeof ResizeObserver;
        globalThis.requestAnimationFrame = ((cb: () => void) =>
            frames.push(cb)) as unknown as typeof requestAnimationFrame;
        return {
            observed,
            unobserved,
            frames,
            fire: () => fire!(),
            restore: () => {
                globalThis.ResizeObserver = realRO;
                globalThis.requestAnimationFrame = realRaf;
            },
        };
    }

    test("observes the element and its whole ancestor chain, and unobserves on disconnect", () => {
        const ro = fakeResizeObserver();
        try {
            const outer = document.createElement("div");
            const inner = document.createElement("div");
            outer.append(inner);
            document.body.append(outer);
            const t = document.createElement("embedded-term") as EmbeddedTerm;
            inner.append(t);
            for (const el of [t, inner, outer, document.body, document.documentElement]) {
                expect(ro.observed).toContain(el);
            }
            t.remove();
            for (const el of [t, inner, outer]) {
                expect(ro.unobserved).toContain(el);
            }
        } finally {
            ro.restore();
        }
    });

    test("a bubbling grid-resize schedules a deferred refit", () => {
        const ro = fakeResizeObserver();
        try {
            const wrap = document.createElement("div");
            document.body.append(wrap);
            const t = document.createElement("embedded-term") as EmbeddedTerm;
            wrap.append(t);
            let refits = 0;
            const anyT = t as unknown as { refit(): void };
            const real = anyT.refit.bind(t);
            anyT.refit = () => {
                refits++;
                real();
            };
            const pending = ro.frames.length;
            wrap.dispatchEvent(new CustomEvent("grid-resize", { bubbles: true }));
            expect(refits).toBe(0);
            const added = ro.frames.splice(pending);
            for (const f of added) {
                f();
            }
            expect(refits).toBe(1);
        } finally {
            ro.restore();
        }
    });

    test("observer notifications coalesce into one rAF-deferred refit", () => {
        const ro = fakeResizeObserver();
        try {
            const t = document.createElement("embedded-term") as EmbeddedTerm;
            document.body.append(t);
            let refits = 0;
            const anyT = t as unknown as { refit(): void };
            const real = anyT.refit.bind(t);
            anyT.refit = () => {
                refits++;
                real();
            };
            // (xterm schedules its own rAF frames too, so run only the frames
            // added since the last run, and assert on refits, not frame count.)
            let pending = ro.frames.length;
            const runNew = () => {
                const added = ro.frames.splice(pending);
                pending = ro.frames.length;
                for (const f of added) {
                    f();
                }
            };
            ro.fire();
            ro.fire();
            ro.fire();
            expect(refits).toBe(0); // deferred, and coalesced
            runNew();
            expect(refits).toBe(1);
            ro.fire();
            runNew();
            expect(refits).toBe(2);
        } finally {
            ro.restore();
        }
    });
});

describe("embedded-term — fit", () => {
    // happy-dom reports a zero-sized character cell, so rowsForHeight() cannot
    // derive a row count from pixels here and falls back to max-rows. What is
    // testable is the mode switch: pinned stops the growth, null resumes it.
    test("pinning stops the growth, and null resumes it", async () => {
        const t = make({ "max-rows": "10" });
        await drain(t);
        t.write("hi\r\n");
        await drain(t);
        expect(guts(t).usedRows).toBe(1);

        t.fit(240);
        await drain(t);
        t.write("more\r\nlines\r\n");
        await drain(t);
        expect(guts(t).usedRows).toBe(1); // frozen while pinned

        t.fit(null);
        await drain(t);
        t.write("again");
        await drain(t);
        expect(guts(t).usedRows).toBeGreaterThan(1); // growing again
    });
});
