// @vitest-environment happy-dom
// @vitest-environment-options { "url": "about:blank" }
// The GUI runtime's key handoff: the chords the page gives are handed to it
// (matched as keychord.ts matches them), and modifier keys are reported
// without being kept from the iframe. (The runtime runs in this test's own
// window, which stands for the iframe: it is its own parent.)

import { beforeAll, beforeEach, expect, test } from "vitest";
import { bucheGuiRuntime } from "../src/components/buche-gui-runtime.ts";

const posted: Record<string, unknown>[] = [];

beforeAll(() => {
    const post = window.postMessage.bind(window);
    window.postMessage = ((msg: Record<string, unknown>, ...rest: unknown[]) => {
        if (msg && ["keydown", "keyup", "modifier"].includes(msg["buche-gui"] as string)) {
            posted.push(msg);
            return;
        }
        (post as (...a: unknown[]) => void)(msg, ...rest);
    }) as typeof window.postMessage;
    bucheGuiRuntime();
    window.dispatchEvent(
        new MessageEvent("message", {
            source: window,
            data: { "buche-gui": "config", chords: ["alt+q", "alt+,", "meta+p"] },
        }),
    );
});

beforeEach(() => {
    posted.length = 0;
    window.dispatchEvent(new Event("blur"));
});

const press = (type: "keydown" | "keyup", init: KeyboardEventInit): KeyboardEvent => {
    const e = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
    document.body.dispatchEvent(e);
    return e;
};

test("a chord is handed to the page, then its key-ups", () => {
    const e = press("keydown", { key: "p", code: "KeyP", metaKey: true });
    expect(e.defaultPrevented).toBe(true);
    press("keyup", { key: "Meta", code: "MetaLeft" });
    expect(posted.map((m) => [m["buche-gui"], m.code])).toEqual([
        ["keydown", "KeyP"],
        ["keyup", "MetaLeft"],
    ]);
});

test("Alt chords by their physical key: letters, and punctuation", () => {
    // Mac: Alt+Q types "œ", Alt+, types "≤".
    expect(press("keydown", { key: "œ", code: "KeyQ", altKey: true }).defaultPrevented).toBe(true);
    window.dispatchEvent(new Event("blur"));
    expect(press("keydown", { key: "≤", code: "Comma", altKey: true }).defaultPrevented).toBe(
        true,
    );
    expect(posted.map((m) => m.code)).toEqual(["KeyQ", "Comma"]);
});

test("other keys stay in the iframe", () => {
    expect(press("keydown", { key: "x", code: "KeyX", altKey: true }).defaultPrevented).toBe(
        false,
    );
    expect(posted).toEqual([]);
});

test("modifier keys are reported, and stay in the iframe too", () => {
    const down = press("keydown", { key: "Alt", code: "AltLeft", altKey: true });
    const up = press("keyup", { key: "Alt", code: "AltLeft" });
    expect(down.defaultPrevented || up.defaultPrevented).toBe(false);
    expect(posted.map((m) => [m["buche-gui"], m.type, m.code])).toEqual([
        ["modifier", "keydown", "AltLeft"],
        ["modifier", "keyup", "AltLeft"],
    ]);
});
