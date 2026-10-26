import { describe, expect, test } from "vitest";
import type { Part, TextPart } from "../src/types.ts";
import { flattenParts, plainStructuredText, plainText, spliceText } from "../src/utils.ts";

const parts: TextPart[] = [{ text: "ls", style: "a" }, { text: " " }, { text: "-l", style: "b" }];

describe("structured text helpers", () => {
    test("plainText joins the parts", () => {
        expect(plainText({ parts })).toBe("ls -l");
        expect(plainText({ parts: [] })).toBe("");
        expect(plainText(undefined)).toBe("");
    });

    test("plainStructuredText", () => {
        expect(plainStructuredText("hi")).toEqual({ parts: [{ text: "hi" }] });
        expect(plainStructuredText("")).toEqual({ parts: [] });
    });

    test("unchanged text keeps the parts", () => {
        expect(spliceText(parts, "ls -l")).toBe(parts);
    });

    test("typing at the start goes to the first part", () => {
        expect(spliceText(parts, "xls -l")).toEqual([
            { text: "xls", style: "a" },
            { text: " " },
            { text: "-l", style: "b" },
        ]);
    });

    test("typing at the end goes to the last part", () => {
        expect(spliceText(parts, "ls -la")).toEqual([
            { text: "ls", style: "a" },
            { text: " " },
            { text: "-la", style: "b" },
        ]);
    });

    test("typing at a boundary goes to the part before", () => {
        expect(spliceText(parts, "lsx -l")).toEqual([
            { text: "lsx", style: "a" },
            { text: " " },
            { text: "-l", style: "b" },
        ]);
    });

    test("typing inside a part goes to that part", () => {
        expect(spliceText(parts, "ls -xl")).toEqual([
            { text: "ls", style: "a" },
            { text: " " },
            { text: "-xl", style: "b" },
        ]);
    });

    test("a deletion across parts drops the emptied ones", () => {
        expect(spliceText(parts, "l")).toEqual([{ text: "l", style: "a" }]);
        expect(spliceText(parts, "")).toEqual([]);
        expect(spliceText(parts, "lsl")).toEqual([
            { text: "ls", style: "a" },
            { text: "l", style: "b" },
        ]);
    });

    test("a replacement across parts lands in the part it starts in", () => {
        expect(spliceText(parts, "lZZl")).toEqual([
            { text: "lZZ", style: "a" },
            { text: "l", style: "b" },
        ]);
    });

    test("no parts: the text is a single unstyled part", () => {
        expect(spliceText([], "hi")).toEqual([{ text: "hi" }]);
        expect(spliceText([], "")).toEqual([]);
    });

    test("spacers have no text", () => {
        expect(plainText({ parts: [{ text: "a" }, { spacer: "grow" }, { text: "b" }] })).toBe(
            "ab",
        );
    });

    test("spacers stay put through edits, and never take the typed text", () => {
        const spaced: Part[] = [
            { spacer: "grow" },
            { text: "ls", style: "a" },
            { spacer: "grow" },
        ];
        expect(spliceText(spaced, "xls")).toEqual([
            { spacer: "grow" },
            { text: "xls", style: "a" },
            { spacer: "grow" },
        ]);
        expect(spliceText(spaced, "lsx")).toEqual([
            { spacer: "grow" },
            { text: "lsx", style: "a" },
            { spacer: "grow" },
        ]);
        expect(spliceText(spaced, "")).toEqual([{ spacer: "grow" }, { spacer: "grow" }]);
        expect(spliceText([{ spacer: "grow" }], "hi")).toEqual([
            { spacer: "grow" },
            { text: "hi" },
        ]);
    });

    test("groups: dissolved with their style under their parts'", () => {
        const grouped: Part[] = [
            { text: "x" },
            {
                group: [{ text: "a" }, { group: [{ text: "b", style: "c" }], style: "d" }],
                style: "e",
                action: "go",
            },
        ];
        expect(flattenParts(grouped)).toEqual([
            { text: "x" },
            { text: "a", style: "e" },
            { text: "b", style: "e d c" },
        ]);
        expect(plainText({ parts: grouped })).toBe("xab");
        expect(spliceText(grouped, "xab")).toBe(grouped);
        expect(spliceText(grouped, "xaYb")).toEqual([
            { text: "x" },
            { text: "aY", style: "e" },
            { text: "b", style: "e d c" },
        ]);
    });
});
