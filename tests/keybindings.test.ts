// @vitest-environment happy-dom

import { afterEach, describe, expect, test } from "vitest";
import type { EchoBox } from "../src/components/echo-box.tsx";
import type { EditorFactory, PromptCollection } from "../src/components/prompt-collection.tsx";
import { Entry } from "../src/entry.ts";
import { BucheInterface } from "../src/interface.tsx";
import { ModalKeys } from "../src/keybindings.ts";
import { isMac } from "../src/keychord.ts";
import { Prompt } from "../src/prompt.ts";
import "../src/components/echo-box.tsx";
import "../src/components/prompt-collection.tsx";

afterEach(() => {
    document.body.replaceChildren();
});

function key(
    target: EventTarget,
    type: "keydown" | "keyup",
    init: KeyboardEventInit,
): KeyboardEvent {
    const ev = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(ev);
    return ev;
}

describe("ModalKeys", () => {
    test("chords fire and are swallowed", () => {
        const box = document.createElement("div");
        document.body.append(box);
        const hits: string[] = [];
        const keys = new ModalKeys({ chords: { "Ctrl+p": () => hits.push("p") } });
        keys.attach(box);

        const ev = key(box, "keydown", { key: "p", ctrlKey: true });
        expect(hits).toEqual(["p"]);
        expect(ev.defaultPrevented).toBe(true);

        // Wrong modifier set → no match.
        key(box, "keydown", { key: "p", ctrlKey: true, metaKey: true });
        expect(hits).toEqual(["p"]);
        keys.detach();
    });

    test("capture mode grabs keys until Ctrl is released", () => {
        const box = document.createElement("div");
        document.body.append(box);
        const hits: string[] = [];
        const keys = new ModalKeys({
            capture: { p: () => hits.push("p") },
            release: () => hits.push("release"),
        });
        keys.attach(box);

        expect(key(box, "keydown", { key: "q", ctrlKey: true }).defaultPrevented).toBe(true);
        expect(keys.capturing).toBe(true);

        // Keys are matched by name, whatever modifiers ride along.
        expect(key(box, "keydown", { key: "p", ctrlKey: true }).defaultPrevented).toBe(true);
        // Unknown keys are swallowed but fire no handler.
        expect(key(box, "keydown", { key: "x", ctrlKey: true }).defaultPrevented).toBe(true);
        // Modifier keydowns pass through.
        expect(key(box, "keydown", { key: "Shift", shiftKey: true }).defaultPrevented).toBe(false);
        expect(hits).toEqual(["p"]);

        // Releasing Q keeps the mode; releasing Ctrl ends it and runs `release`.
        key(box, "keyup", { key: "q", ctrlKey: true });
        expect(keys.capturing).toBe(true);
        key(box, "keyup", { key: "ControlLeft" });
        expect(keys.capturing).toBe(false);
        expect(hits).toEqual(["p", "release"]);

        // After release, keys are live again (not swallowed).
        expect(key(box, "keydown", { key: "x" }).defaultPrevented).toBe(false);
        keys.detach();
    });

    test("Mod expands per-platform in chords", () => {
        const box = document.createElement("div");
        document.body.append(box);
        let hits = 0;
        const keys = new ModalKeys({ chords: { "Mod+p": () => hits++ } });
        keys.attach(box);
        key(box, "keydown", { key: "p", ...(isMac() ? { metaKey: true } : { ctrlKey: true }) });
        expect(hits).toBe(1);
        keys.detach();
    });
});

function makeInterface(): [BucheInterface, HTMLElement] {
    const container = document.createElement("div");
    document.body.append(container);
    const iface = new BucheInterface({ container, template: "<div></div>" });
    return [iface, container];
}

function makeCell(entry?: Entry): [EchoBox, Entry] {
    const e = entry ?? new Entry({});
    const box = document.createElement("echo-box") as EchoBox;
    box.bindEntry(e);
    return [box, e];
}

// A prompt-collection with one prompt and a focusable stub editor (no
// CodeMirror), so prompt focus is observable through document.activeElement.
function makePromptCollection(): [PromptCollection, Entry] {
    const pc = document.createElement("prompt-collection") as PromptCollection;
    pc.editorFactory = (({ doc }: { doc: string }) => {
        const dom = document.createElement("div");
        dom.className = "stub-editor";
        dom.tabIndex = -1;
        dom.textContent = doc;
        return {
            dom,
            getValue: () => dom.textContent ?? "",
            setValue: (v: string) => {
                dom.textContent = v;
            },
            focus: () => dom.focus(),
            destroy: () => dom.remove(),
        };
    }) as EditorFactory;
    const entry = new Entry({});
    entry.setPrompt(new Prompt({ prompt: { text: "$", ranges: [] } }));
    pc.addPrompt(entry);
    return [pc, entry];
}

describe("BucheInterface global bindings", () => {
    test("Ctrl+Q then ↓/↓ navigates and highlights cells", () => {
        const [iface, container] = makeInterface();
        const [b1] = makeCell();
        const [b2] = makeCell();
        container.append(b1, b2);

        key(container, "keydown", { key: "q", ctrlKey: true });
        key(container, "keydown", { key: "ArrowDown", ctrlKey: true });
        expect(iface.focus.focusedCell).toBe(b1);
        expect(b1.classList.contains("cell-focused")).toBe(true);
        key(container, "keydown", { key: "ArrowDown", ctrlKey: true });
        expect(iface.focus.focusedCell).toBe(b2);
        expect(b1.classList.contains("cell-focused")).toBe(false);
        // Clamped at the ends.
        key(container, "keydown", { key: "ArrowDown", ctrlKey: true });
        expect(iface.focus.focusedCell).toBe(b2);
        iface.keys.detach();
    });

    test("'k' signals the focused cell's entry", async () => {
        const [iface, container] = makeInterface();
        const [b1, entry] = makeCell();
        container.append(b1);

        key(container, "keydown", { key: "q", ctrlKey: true });
        key(container, "keydown", { key: "ArrowDown", ctrlKey: true });
        b1.status = "running";
        key(container, "keydown", { key: "k", ctrlKey: true });
        // An unresponsive cell gets SIGKILL instead (like the ✕ handler).
        key(container, "keydown", { key: "ArrowDown", ctrlKey: true });
        b1.status = "unresponsive";
        key(container, "keydown", { key: "k", ctrlKey: true });

        const messages = Array.from(iface.interactions.purge());
        expect(messages).toEqual([
            { type: "user_signal", code: 15, entry },
            { type: "user_signal", code: 9, entry },
        ]);
        iface.keys.detach();
    });

    test("'d' dispatches the close event, like clicking ✕", () => {
        const [iface, container] = makeInterface();
        const [b1] = makeCell();
        container.append(b1);

        let closes = 0;
        container.addEventListener("close", () => closes++);

        key(container, "keydown", { key: "q", ctrlKey: true });
        key(container, "keydown", { key: "ArrowDown", ctrlKey: true });
        key(container, "keydown", { key: "d", ctrlKey: true });
        expect(closes).toBe(1);
        iface.keys.detach();
    });

    test("selecting a cell focuses the embedded term inside it", () => {
        const [iface, container] = makeInterface();
        const [b1] = makeCell();
        const term = document.createElement("embedded-term");
        let focused = 0;
        term.focus = () => {
            focused++;
        };
        b1.setView("pty", term);
        container.append(b1);

        key(container, "keydown", { key: "q", ctrlKey: true });
        key(container, "keydown", { key: "ArrowDown", ctrlKey: true });
        expect(focused).toBe(1);
        // Ctrl-release does not steal focus back from the terminal.
        key(window, "keyup", { key: "Control" });
        expect(focused).toBe(1);
        iface.keys.detach();
    });

    test("down steps from the last cell onto the prompt; up steps back", () => {
        const [iface, container] = makeInterface();
        const [b1] = makeCell();
        const [b2] = makeCell();
        const [pc] = makePromptCollection();
        container.append(b1, b2, pc);

        key(container, "keydown", { key: "q", ctrlKey: true });
        key(container, "keydown", { key: "ArrowDown", ctrlKey: true });
        expect(iface.focus.focusedCell).toBe(b1);
        key(container, "keydown", { key: "ArrowDown", ctrlKey: true });
        expect(iface.focus.focusedCell).toBe(b2);
        // Down past the last cell: the prompt takes focus, selection cleared.
        key(container, "keydown", { key: "ArrowDown", ctrlKey: true });
        expect(iface.focus.promptHasFocus()).toBe(true);
        expect(iface.focus.focusedCell).toBeNull();
        expect(b2.classList.contains("cell-focused")).toBe(false);
        // Up from the prompt: back to the last cell.
        key(container, "keydown", { key: "ArrowUp", ctrlKey: true });
        expect(iface.focus.focusedCell).toBe(b2);
        // Down to the prompt again, then down wraps to the first cell.
        key(container, "keydown", { key: "ArrowDown", ctrlKey: true });
        key(container, "keydown", { key: "ArrowDown", ctrlKey: true });
        expect(iface.focus.focusedCell).toBe(b1);
        iface.keys.detach();
    });

    test("releasing Ctrl focuses the selected cell", () => {
        const [iface, container] = makeInterface();
        const [b1] = makeCell();
        container.append(b1);

        key(container, "keydown", { key: "q", ctrlKey: true });
        key(container, "keydown", { key: "ArrowDown", ctrlKey: true });
        key(window, "keyup", { key: "Control" });

        expect(iface.keys.capturing).toBe(false);
        expect(document.activeElement).toBe(b1);
        expect(b1.tabIndex).toBe(-1);
        iface.keys.detach();
    });
});
