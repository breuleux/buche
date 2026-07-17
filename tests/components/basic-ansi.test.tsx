// @vitest-environment happy-dom

import { afterEach, describe, expect, test } from "vitest";
import { type BasicAnsi, TermBuffer } from "../../src/components/basic-ansi.tsx";

afterEach(() => {
    document.body.replaceChildren();
});

function make(): BasicAnsi {
    const el = document.createElement("basic-ansi") as BasicAnsi;
    document.body.append(el);
    return el;
}

// The <pre> that holds completed lines + the current partial line.
function pre(el: BasicAnsi): HTMLElement {
    return el.querySelector(".basic-ansi-lines")!;
}

// Style attribute of the first styled run in the first completed line.
function firstRun(el: BasicAnsi): HTMLElement {
    return pre(el).querySelector("span > span")!;
}

describe("basic-ansi — rendering", () => {
    test("renders plain text as a completed line plus a cursor", () => {
        const el = make();
        el.write("hello\n");
        expect(pre(el).textContent).toBe("hello\n");
        expect(pre(el).querySelectorAll(".cursor").length).toBe(1);
        expect(el.lineCount).toBe(1);
    });

    test("colours an SGR run and coalesces equal styles", () => {
        const el = make();
        el.write("\x1b[32mgreen\x1b[0m\n");
        const run = firstRun(el);
        expect(run.textContent).toBe("green");
        // code 32 → the 3rd of the 16 ANSI colours (#4e9a06).
        expect(run.getAttribute("style")).toContain("#4e9a06");
    });

    test("applies bold, italic and underline", () => {
        const el = make();
        el.write("\x1b[1mB\x1b[22m\x1b[3mI\x1b[23m\x1b[4mU\x1b[0m\n");
        const styles = Array.from(pre(el).querySelectorAll("span > span")).map(
            (s) => s.getAttribute("style") ?? "",
        );
        expect(
            styles.some((s) => s.includes("font-weight:bold") || s.includes("font-weight: bold")),
        ).toBe(true);
        expect(
            styles.some(
                (s) => s.includes("font-style:italic") || s.includes("font-style: italic"),
            ),
        ).toBe(true);
        expect(styles.some((s) => s.includes("underline"))).toBe(true);
    });

    test("256-colour and truecolour SGR", () => {
        const el = make();
        el.write("\x1b[38;5;46ma\x1b[0m\x1b[38;2;10;20;30mb\x1b[0m\n");
        const runs = pre(el).querySelectorAll("span > span");
        expect(runs[0].getAttribute("style")).toContain("rgb(0, 255, 0)");
        expect(runs[1].getAttribute("style")).toContain("rgb(10, 20, 30)");
    });

    test("stderr stream gets its own class", () => {
        const el = make();
        el.write("oops\n", "stderr");
        expect(pre(el).querySelector(".text-stderr")?.textContent).toBe("oops");
    });
});

describe("basic-ansi — control characters", () => {
    test("carriage return overwrites from the start of the line", () => {
        const el = make();
        el.write("abc\rX\n");
        expect(pre(el).textContent).toBe("Xbc\n");
    });

    test("backspace moves the write position back", () => {
        const el = make();
        el.write("abc\b\bX\n");
        expect(pre(el).textContent).toBe("aXc\n");
    });

    test("tab advances to the next 8-column stop", () => {
        const el = make();
        el.write("a\tb\n");
        expect(pre(el).textContent).toBe(`a${" ".repeat(7)}b\n`);
    });

    test("holds an incomplete escape across writes", () => {
        const el = make();
        el.write("\x1b[32"); // split mid-escape
        el.write("mgreen\x1b[0m\n");
        expect(pre(el).textContent).toBe("green\n");
        expect(firstRun(el).getAttribute("style")).toContain("#4e9a06");
    });
});

describe("basic-ansi — counters and clearing", () => {
    test("lineCount and byteLength track completed + partial content", () => {
        const el = make();
        el.write("abc\n");
        el.write("de"); // partial line, no newline
        expect(el.lineCount).toBe(1);
        expect(el.byteLength).toBe(5); // 3 completed + 2 current
    });

    test("\\x1b[2J clears the view and reports it", () => {
        const el = make();
        el.write("keep\n");
        const res = el.write("\x1b[2J");
        expect(res.cleared).toBe(true);
        expect(el.lineCount).toBe(0);
        expect(pre(el).textContent).toBe("");
    });

    test("setCursorEnabled(false) removes the cursor; true restores it", () => {
        const el = make();
        el.write("x");
        expect(pre(el).querySelectorAll(".cursor").length).toBe(1);
        el.setCursorEnabled(false);
        expect(pre(el).querySelectorAll(".cursor").length).toBe(0);
        el.setCursorEnabled(true);
        expect(pre(el).querySelectorAll(".cursor").length).toBe(1);
    });
});

describe("basic-ansi — prune", () => {
    test("drops whole leading lines to meet the line budget", () => {
        const el = make();
        for (let i = 1; i <= 5; i++) {
            el.write(`line${i}\n`);
        }
        const dropped = el.prune(Number.POSITIVE_INFINITY, 2);
        expect(dropped.lines).toBe(3);
        expect(el.lineCount).toBe(2);
        expect(pre(el).textContent).toBe("line4\nline5\n");
    });

    test("meets the byte budget by trimming the straddling line", () => {
        const el = make();
        el.write("aaaaa\n");
        el.write("aaaaa\n");
        el.write("aaaaa\n"); // 15 chars across 3 lines
        const dropped = el.prune(7);
        // Drop the first line (5), then trim 3 chars off the second.
        expect(dropped).toEqual({ lines: 1, bytes: 8 });
        expect(el.byteLength).toBe(7);
        expect(pre(el).textContent).toBe("aa\naaaaa\n");
    });

    test("never prunes the current (partial) line", () => {
        const el = make();
        el.write("done\n");
        el.write("partial"); // 7-char current line
        el.prune(1); // budget below the current line's size
        expect(el.lineCount).toBe(0); // completed line dropped
        expect(pre(el).textContent).toBe("partial");
    });
});

describe("basic-ansi — giant line", () => {
    test("maxLineBytes caps a single newline-less line", () => {
        const el = make();
        el.maxLineBytes = 100;
        el.write("Z".repeat(10_000));
        expect(el.byteLength).toBe(100);
        el.write("\n");
        expect(el.lineCount).toBe(1);
        expect(pre(el).textContent).toBe(`${"Z".repeat(100)}\n`);
    });
});

describe("TermBuffer.containsUnhandledEscape", () => {
    test("false for handled SGR / erase sequences", () => {
        expect(TermBuffer.containsUnhandledEscape("\x1b[0m\x1b[2J\x1b[K")).toBe(false);
    });

    test("true for a sequence this text view cannot render", () => {
        expect(TermBuffer.containsUnhandledEscape("\x1b[?25h")).toBe(true); // show-cursor
    });
});
