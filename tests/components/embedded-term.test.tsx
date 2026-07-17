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

describe("embedded-term — resize polling", () => {
    // Frame-stepped rAF so tests control when the poll ticks happen. A poll
    // step re-arms itself at the start, so each runNew runs exactly one
    // generation of frames (xterm schedules frames of its own too).
    function fakeFrames() {
        const frames = new Map<number, () => void>();
        let seq = 0;
        const realRaf = globalThis.requestAnimationFrame;
        const realCancel = globalThis.cancelAnimationFrame;
        globalThis.requestAnimationFrame = ((cb: () => void) => {
            frames.set(++seq, cb);
            return seq;
        }) as unknown as typeof requestAnimationFrame;
        globalThis.cancelAnimationFrame = ((id: number) => {
            frames.delete(id);
        }) as unknown as typeof cancelAnimationFrame;
        const runNew = () => {
            const batch = Array.from(frames.values());
            frames.clear();
            for (const cb of batch) {
                cb();
            }
        };
        return {
            pending: () => frames.size,
            runNew,
            restore: () => {
                globalThis.requestAnimationFrame = realRaf;
                globalThis.cancelAnimationFrame = realCancel;
            },
        };
    }

    // happy-dom has no layout, so clientWidth/clientHeight are stubbed on the
    // container to simulate geometry changes.
    function sizedWrap(
        width: number,
        height: number,
    ): { wrap: HTMLElement; size: (w: number, h: number) => void } {
        const wrap = document.createElement("div");
        let w = width;
        let h = height;
        Object.defineProperty(wrap, "clientWidth", { configurable: true, get: () => w });
        Object.defineProperty(wrap, "clientHeight", { configurable: true, get: () => h });
        document.body.append(wrap);
        return {
            wrap,
            size: (nw, nh) => {
                w = nw;
                h = nh;
            },
        };
    }

    const countRefits = (t: EmbeddedTerm): { n: number } => {
        const g = { n: 0 };
        const anyT = t as unknown as { refit(): void };
        const real = anyT.refit.bind(t);
        anyT.refit = () => {
            g.n++;
            real();
        };
        return g;
    };

    test("the first frames set a baseline without refitting", () => {
        const raf = fakeFrames();
        try {
            const { wrap } = sizedWrap(100, 50);
            const t = document.createElement("embedded-term") as EmbeddedTerm;
            wrap.append(t);
            const refits = countRefits(t);
            raf.runNew();
            raf.runNew();
            expect(refits.n).toBe(0);
        } finally {
            raf.restore();
        }
    });

    test("a dimension change refits once, deferred a frame", () => {
        const raf = fakeFrames();
        try {
            const { wrap, size } = sizedWrap(100, 50);
            const t = document.createElement("embedded-term") as EmbeddedTerm;
            wrap.append(t);
            const refits = countRefits(t);
            raf.runNew(); // baseline
            size(200, 50);
            raf.runNew(); // the poll notices…
            expect(refits.n).toBe(0); // …and defers the refit
            raf.runNew(); // …which runs next frame
            expect(refits.n).toBe(1);
            raf.runNew();
            expect(refits.n).toBe(1); // no change → no further refit
        } finally {
            raf.restore();
        }
    });

    test("a hidden container is quiet, and returning re-derives the size", () => {
        const raf = fakeFrames();
        try {
            const { wrap, size } = sizedWrap(100, 50);
            const t = document.createElement("embedded-term") as EmbeddedTerm;
            wrap.append(t);
            const refits = countRefits(t);
            raf.runNew(); // baseline
            size(0, 0); // hidden tab
            raf.runNew();
            raf.runNew();
            expect(refits.n).toBe(0); // nothing is derived while hidden
            size(100, 50); // same size, but coming back re-derives it
            raf.runNew();
            raf.runNew();
            expect(refits.n).toBe(1);
        } finally {
            raf.restore();
        }
    });

    test("a term created hidden derives its size on first sight", () => {
        const raf = fakeFrames();
        try {
            const { wrap, size } = sizedWrap(0, 0);
            const t = document.createElement("embedded-term") as EmbeddedTerm;
            wrap.append(t);
            const refits = countRefits(t);
            raf.runNew(); // hidden: nothing yet, no baseline taken
            size(100, 50);
            raf.runNew();
            raf.runNew();
            expect(refits.n).toBe(1); // first sight is a derivation, not a baseline
        } finally {
            raf.restore();
        }
    });

    test("a grid change dispatches a bubbling term-resize", () => {
        const t = document.createElement("embedded-term") as EmbeddedTerm;
        document.body.append(t);
        let fired = 0;
        let grid = "";
        document.body.addEventListener("term-resize", () => {
            fired++;
            grid = `${t.terminal.rows}x${t.terminal.cols}`;
        });
        // happy-dom has no metrics, so force the grid move the settle path makes.
        (t as unknown as { resizeTerminal(rows: number): void }).resizeTerminal(20);
        expect(fired).toBe(1);
        expect(grid).toBe("20x80");
        // No-op fits do not re-dispatch.
        (t as unknown as { resizeTerminal(rows: number): void }).resizeTerminal(20);
        expect(fired).toBe(1);
    });

    test("disconnect stops the polling", () => {
        const raf = fakeFrames();
        try {
            const { wrap, size } = sizedWrap(100, 50);
            const t = document.createElement("embedded-term") as EmbeddedTerm;
            let refits = 0;
            wrap.append(t);
            const anyT = t as unknown as { refit(): void };
            const real = anyT.refit.bind(t);
            anyT.refit = () => {
                refits++;
                real();
            };
            raf.runNew(); // baseline
            t.remove();
            size(200, 50);
            raf.runNew();
            raf.runNew();
            expect(refits).toBe(0);
        } finally {
            raf.restore();
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
