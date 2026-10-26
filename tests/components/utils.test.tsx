// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { styleToCss, defaultTheme as th } from "../../src/color.ts";
import { buildStructuredText } from "../../src/components/utils.tsx";
import type { InteractiveStructuredText } from "../../src/types.ts";

const css = (accent: string) => styleToCss(th.calculateStyle(accent));

describe("buildStructuredText", () => {
    test("wraps everything in a .styled-text span", () => {
        const node = buildStructuredText({ parts: [{ text: "hi" }] }, th);
        expect(node.tagName).toBe("SPAN");
        expect(node.className).toBe("styled-text");
        expect(node.textContent).toBe("hi");
    });

    test("an unstyled part is a single text node", () => {
        const node = buildStructuredText({ parts: [{ text: "hello" }] }, th);
        expect(node.childNodes.length).toBe(1);
        expect(node.childNodes[0].nodeType).toBe(Node.TEXT_NODE);
    });

    test("no parts is empty", () => {
        const node = buildStructuredText({ parts: [] }, th);
        expect(node.childNodes.length).toBe(0);
        expect(node.textContent).toBe("");
    });

    test("renders styled parts as spans and unstyled ones as text", () => {
        const node = buildStructuredText(
            {
                parts: [
                    { text: "git", style: "green bold" },
                    { text: " " },
                    { text: "commit", style: "cyan" },
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

        // The unstyled part is a bare text node.
        expect(node.childNodes[1].nodeType).toBe(Node.TEXT_NODE);
        expect(node.childNodes[1].textContent).toBe(" ");
    });

    test("a null style is unstyled", () => {
        const node = buildStructuredText(
            {
                parts: [
                    { text: "ab ", style: null },
                    { text: "CD", style: "red" },
                    { text: " ef" },
                ],
            },
            th,
        );
        expect(node.childNodes[0].textContent).toBe("ab ");
        expect(node.childNodes[0].nodeType).toBe(Node.TEXT_NODE);
        expect((node.childNodes[1] as HTMLElement).tagName).toBe("SPAN");
        expect(node.childNodes[1].textContent).toBe("CD");
        expect(node.childNodes[2].textContent).toBe(" ef");
    });

    test("drops empty parts", () => {
        const node = buildStructuredText(
            {
                parts: [
                    { text: "", style: "red" },
                    { text: "abcdef" },
                    { text: "", style: "blue" },
                ],
            },
            th,
        );
        expect(node.querySelectorAll("span").length).toBe(0);
        expect(node.textContent).toBe("abcdef");
    });

    test("renders text of an unparseable accent without styling", () => {
        const node = buildStructuredText({ parts: [{ text: "xyz", style: "chartreuse" }] }, th);
        const span = node.querySelector("span")!;
        expect(span.textContent).toBe("xyz");
        expect(span.getAttribute("style")).toBeNull();
    });

    test("ignores the interactive fields (selection, editability, filigrane)", () => {
        const interactive: InteractiveStructuredText = {
            parts: [{ text: "abc" }],
            selection: { start: 2, end: 2 },
            editability: "editable",
            filigrane: "abc -l",
        };
        const node = buildStructuredText(interactive, th);
        expect(node.textContent).toBe("abc");
    });

    test("without spacers, there are no segments", () => {
        const node = buildStructuredText(
            { parts: [{ text: "a" }, { text: "b", style: "red" }] },
            th,
        );
        expect(node.classList.contains("styled-text-spaced")).toBe(false);
        expect(node.querySelector(".styled-text-segment")).toBeNull();
    });

    test("spacers split the text into segments, in a spaced row", () => {
        const node = buildStructuredText(
            {
                parts: [
                    { text: "host", style: "red" },
                    { text: " ⬥ " },
                    { text: "~/src" },
                    { spacer: "grow" },
                    { text: "12:34", style: "blue" },
                ],
            },
            th,
        );
        expect(node.className).toBe("styled-text styled-text-spaced");
        expect(node.textContent).toBe("host ⬥ ~/src12:34");
        const children = [...node.children].map((el) => [el.className, el.textContent]);
        expect(children).toEqual([
            ["styled-text-segment", "host ⬥ ~/src"],
            ["styled-text-spacer", ""],
            ["styled-text-segment", "12:34"],
        ]);
        // The parts keep their styling within their segment.
        const [left, , right] = node.children;
        expect(left.querySelector("span")?.textContent).toBe("host");
        expect(left.childNodes[1].nodeType).toBe(Node.TEXT_NODE);
        expect(right.querySelector("span")?.getAttribute("style")).toBe(css("blue"));
    });

    test("leading, trailing and consecutive spacers make no empty segments", () => {
        const node = buildStructuredText(
            {
                parts: [
                    { spacer: "grow" },
                    { text: "mid" },
                    { spacer: "grow" },
                    { spacer: "grow" },
                ],
            },
            th,
        );
        expect([...node.children].map((el) => el.className)).toEqual([
            "styled-text-spacer",
            "styled-text-segment",
            "styled-text-spacer",
            "styled-text-spacer",
        ]);
    });

    test("with onAction, a part with an action fires it when clicked", () => {
        const fired: unknown[] = [];
        const node = buildStructuredText(
            {
                parts: [
                    { text: "host " },
                    { text: "~/src", style: "red", action: "ls" },
                    { text: " plain", action: { command: "go", freeze: true } },
                    { spacer: "grow", action: "far" },
                ],
            },
            th,
            (action) => fired.push(action),
        );
        const clickable = [...node.querySelectorAll<HTMLElement>(".styled-text-action")];
        expect(clickable.map((el) => el.textContent)).toEqual(["~/src", " plain", ""]);
        expect(clickable[0].getAttribute("style")).toBe(css("red"));
        expect(clickable[2].classList.contains("styled-text-spacer")).toBe(true);
        for (const el of clickable) {
            el.click();
        }
        expect(fired).toEqual(["ls", { command: "go", freeze: true }, "far"]);

        // Pressing it doesn't take the focus or start a selection.
        const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
        clickable[0].dispatchEvent(down);
        expect(down.defaultPrevented).toBe(true);
    });

    test("without onAction, actions are ignored", () => {
        const node = buildStructuredText(
            {
                parts: [
                    { text: "a", action: "x" },
                    { text: "b", style: "red", action: "y" },
                ],
            },
            th,
        );
        expect(node.querySelector(".styled-text-action")).toBeNull();
        expect(node.childNodes[0].nodeType).toBe(Node.TEXT_NODE);
    });

    test("a group styles its parts and its action covers them all", () => {
        const fired: unknown[] = [];
        const node = buildStructuredText(
            {
                parts: [
                    {
                        group: [{ text: "a" }, { text: "b", style: "red" }, { spacer: "grow" }],
                        style: "bold",
                        action: "g",
                    },
                    { text: "c" },
                ],
            },
            th,
            (action) => fired.push(action),
        );
        // (Not spaced: a spacer in a group is ignored.)
        expect(node.classList.contains("styled-text-spaced")).toBe(false);
        const group = node.querySelector<HTMLElement>(".styled-text-group");
        expect(group?.classList.contains("styled-text-action")).toBe(true);
        expect(group?.textContent).toBe("ab");
        const [a, b] = [...(group?.children ?? [])];
        expect(a.getAttribute("style")).toBe(css("bold"));
        expect(b.getAttribute("style")).toBe(css("bold red"));
        (b as HTMLElement).click();
        expect(fired).toEqual(["g"]);
        expect(node.textContent).toBe("abc");
    });

    test("a group without an action leaves no wrapper", () => {
        const node = buildStructuredText(
            { parts: [{ group: [{ text: "a" }], style: "red", action: "x" }] },
            th,
        );
        expect(node.querySelector(".styled-text-group")).toBeNull();
        expect(node.children[0].getAttribute("style")).toBe(css("red"));
    });
});
