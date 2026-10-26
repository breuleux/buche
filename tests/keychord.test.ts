// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { chordFromEvent, normalizeChord } from "../src/keychord.ts";

const chord = (init: KeyboardEventInit) => chordFromEvent(new KeyboardEvent("keydown", init));

describe("chordFromEvent", () => {
    test("names a key as typed", () => {
        expect(chord({ key: "l", code: "KeyL", ctrlKey: true })).toBe("ctrl+l");
        expect(chord({ key: "a", code: "KeyA", altKey: true })).toBe("alt+a"); // (Linux)
        expect(chord({ key: "Enter", code: "Enter" })).toBe("enter");
    });

    test("an Alt chord a Mac types as a special character is named by its key", () => {
        expect(chord({ key: "å", code: "KeyA", altKey: true })).toBe(normalizeChord("Alt+a"));
        expect(chord({ key: "Å", code: "KeyA", altKey: true, shiftKey: true })).toBe(
            normalizeChord("Alt+Shift+a"),
        );
        expect(chord({ key: "¡", code: "Digit1", altKey: true })).toBe("alt+1");
        expect(chord({ key: "≤", code: "Comma", altKey: true })).toBe("alt+,");
    });

    test("so is an Alt dead key", () => {
        expect(chord({ key: "Dead", code: "KeyE", altKey: true })).toBe(normalizeChord("Alt+e"));
        expect(chord({ key: "Dead", code: "KeyN", altKey: true })).toBe("alt+n");
    });

    test("without Alt, special characters are left alone (other layouts)", () => {
        expect(chord({ key: "é", code: "Digit2" })).toBe("é");
        expect(chord({ key: "Dead", code: "BracketLeft" })).toBe("dead");
    });
});
