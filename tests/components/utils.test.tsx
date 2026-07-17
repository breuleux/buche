// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { styleToCss, defaultTheme as th } from "../../src/color.ts";
import { buildStyledText } from "../../src/components/utils.tsx";
import type { InteractiveStyledText } from "../../src/types.ts";

const css = (accent: string) => styleToCss(th.calculateStyle(accent));

describe("buildStyledText", () => {
    test("wraps everything in a .styled-text span", () => {
        const node = buildStyledText({ text: "hi", ranges: [] }, th);
        expect(node.tagName).toBe("SPAN");
        expect(node.className).toBe("styled-text");
        expect(node.textContent).toBe("hi");
    });

    test("plain text with no ranges is a single text node", () => {
        const node = buildStyledText({ text: "hello", ranges: [] }, th);
        expect(node.childNodes.length).toBe(1);
        expect(node.childNodes[0].nodeType).toBe(Node.TEXT_NODE);
    });

    test("splits into plain segments and styled spans", () => {
        const node = buildStyledText(
            {
                text: "git commit",
                ranges: [
                    { start: 0, end: 3, style: "green bold" },
                    { start: 4, end: 10, style: "cyan" },
                ],
            },
            th,
        );

        // "git"(span) + " "(text) + "commit"(span)
        expect(node.textContent).toBe("git commit");
        const spans = node.querySelectorAll("span");
        expect(spans.length).toBe(2);
        expect(spans[0].textContent).toBe("git");
        expect(spans[0].getAttribute("style")).toBe(css("green bold"));
        expect(spans[1].textContent).toBe("commit");
        expect(spans[1].getAttribute("style")).toBe(css("cyan"));

        // The gap between the ranges is a bare text node.
        expect(node.childNodes[1].nodeType).toBe(Node.TEXT_NODE);
        expect(node.childNodes[1].textContent).toBe(" ");
    });

    test("emits leading and trailing plain text", () => {
        const node = buildStyledText(
            { text: "ab CD ef", ranges: [{ start: 3, end: 5, style: "red" }] },
            th,
        );
        expect(node.childNodes[0].textContent).toBe("ab ");
        expect((node.childNodes[1] as HTMLElement).tagName).toBe("SPAN");
        expect(node.childNodes[1].textContent).toBe("CD");
        expect(node.childNodes[2].textContent).toBe(" ef");
    });

    test("clamps out-of-range offsets to the text", () => {
        const node = buildStyledText(
            { text: "abc", ranges: [{ start: -5, end: 99, style: "blue" }] },
            th,
        );
        const span = node.querySelector("span")!;
        expect(span.textContent).toBe("abc");
        expect(node.textContent).toBe("abc");
    });

    test("drops empty or inverted ranges", () => {
        const node = buildStyledText(
            {
                text: "abcdef",
                ranges: [
                    { start: 2, end: 2, style: "red" }, // empty
                    { start: 4, end: 1, style: "blue" }, // inverted
                ],
            },
            th,
        );
        expect(node.querySelectorAll("span").length).toBe(0);
        expect(node.textContent).toBe("abcdef");
    });

    test("trims a range overlapping already-emitted text", () => {
        const node = buildStyledText(
            {
                text: "abcdef",
                ranges: [
                    { start: 0, end: 4, style: "red" },
                    { start: 2, end: 6, style: "blue" }, // overlaps → trimmed to [4,6)
                ],
            },
            th,
        );
        const spans = node.querySelectorAll("span");
        expect(spans.length).toBe(2);
        expect(spans[0].textContent).toBe("abcd");
        expect(spans[1].textContent).toBe("ef");
        expect(node.textContent).toBe("abcdef");
    });

    test("renders text of an unparseable accent without styling", () => {
        const node = buildStyledText(
            { text: "xyz", ranges: [{ start: 0, end: 3, style: "chartreuse" }] },
            th,
        );
        const span = node.querySelector("span")!;
        expect(span.textContent).toBe("xyz");
        expect(span.getAttribute("style")).toBeNull();
    });

    test("ignores the interactive fields (position, editability, filigrane)", () => {
        const interactive: InteractiveStyledText = {
            text: "abc",
            ranges: [],
            position: 2,
            editability: "editable",
            filigrane: "abc -l",
        };
        const node = buildStyledText(interactive, th);
        expect(node.textContent).toBe("abc");
    });

    test("null boundaries resolve to the text edges (0 / length)", () => {
        // null start → 0, null end → text.length; {null,null} covers everything.
        const whole = buildStyledText(
            { text: "abcdef", ranges: [{ start: null, end: null, style: "red" }] },
            th,
        );
        expect(whole.querySelector("span")?.textContent).toBe("abcdef");

        const head = buildStyledText(
            { text: "abcdef", ranges: [{ start: null, end: 3, style: "red" }] },
            th,
        );
        expect(head.childNodes[0].textContent).toBe("abc"); // styled span
        expect((head.childNodes[0] as HTMLElement).tagName).toBe("SPAN");
        expect(head.childNodes[1].textContent).toBe("def"); // trailing text

        const tail = buildStyledText(
            { text: "abcdef", ranges: [{ start: 3, end: null, style: "red" }] },
            th,
        );
        expect(tail.childNodes[0].textContent).toBe("abc"); // leading text
        expect((tail.childNodes[1] as HTMLElement).tagName).toBe("SPAN");
        expect(tail.childNodes[1].textContent).toBe("def");
    });
});
