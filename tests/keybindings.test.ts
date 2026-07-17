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
        const keys = new ModalKeys({
            chords: {
                "Ctrl+p": () => {
                    hits.push("p");
                },
            },
        });
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
            capture: {
                p: () => {
                    hits.push("p");
                },
            },
            release: () => {
                hits.push("release");
            },
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

    test("capture keys can be bound with modifiers other than Ctrl", () => {
        const box = document.createElement("div");
        document.body.append(box);
        const hits: string[] = [];
        const keys = new ModalKeys({
            capture: {
                ArrowUp: () => {
                    hits.push("up");
                },
                "Shift+ArrowUp": () => {
                    hits.push("shift+up");
                },
            },
            onEnter: () => {
                hits.push("enter");
            },
        });
        keys.attach(box);

        key(box, "keydown", { key: "q", ctrlKey: true });
        key(box, "keydown", { key: "ArrowUp", ctrlKey: true });
        key(box, "keydown", { key: "ArrowUp", ctrlKey: true, shiftKey: true });
        // No Alt binding: falls back to the bare key's.
        key(box, "keydown", { key: "ArrowUp", ctrlKey: true, altKey: true });
        expect(hits).toEqual(["enter", "up", "shift+up", "up"]);
        keys.detach();
    });

    test("Mod expands per-platform in chords", () => {
        const box = document.createElement("div");
        document.body.append(box);
        let hits = 0;
        const keys = new ModalKeys({
            chords: {
                "Mod+p": () => {
                    hits++;
                },
            },
        });
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
    entry.setPrompt(new Prompt({ submission: { context: { text: "$", ranges: [] } } }));
    pc.addPrompt(entry);
    return [pc, entry];
}

// The interface's FocusManager navigates by layout; happy-dom has none (all
// rects are empty), but it does compute inline `display`/`flex-direction`, and
// empty rects keep flex items in DOM order — enough for a flex column.
function column(container: HTMLElement): void {
    container.style.display = "flex";
    container.style.flexDirection = "column";
}

const promptRow = (pc: PromptCollection) =>
    pc.querySelector<HTMLElement>('[focusable="prompt"]:not([hidden])')!;

describe("BucheInterface global bindings", () => {
    test("Ctrl+Q then ↓/↓ navigates and highlights cells", () => {
        const [iface, container] = makeInterface();
        column(container);
        const [b1] = makeCell();
        const [b2] = makeCell();
        container.append(b1, b2);

        key(container, "keydown", { key: "q", ctrlKey: true });
        key(container, "keydown", { key: "ArrowDown", ctrlKey: true });
        expect(iface.focus.current).toBe(b1);
        expect(b1.hasAttribute("focused")).toBe(true);
        key(container, "keydown", { key: "ArrowDown", ctrlKey: true });
        expect(iface.focus.current).toBe(b2);
        expect(b1.hasAttribute("focused")).toBe(false);
        // Nothing past the end.
        key(container, "keydown", { key: "ArrowDown", ctrlKey: true });
        expect(iface.focus.current).toBe(b2);
        iface.keys.detach();
    });

    test("'k' signals the focused cell's entry", () => {
        const [iface, container] = makeInterface();
        const [b1, entry] = makeCell();
        container.append(b1);
        iface.focus.focus(b1);

        key(container, "keydown", { key: "q", ctrlKey: true });
        b1.status = "running";
        key(container, "keydown", { key: "k", ctrlKey: true });
        // An unresponsive cell gets SIGKILL instead (like the ✕ handler).
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
        iface.focus.focus(b1);

        let closes = 0;
        container.addEventListener("close", () => closes++);

        key(container, "keydown", { key: "q", ctrlKey: true });
        key(container, "keydown", { key: "d", ctrlKey: true });
        expect(closes).toBe(1);
        iface.keys.detach();
    });

    test("from a prompt, 'k' and 'd' apply to the cell right above it", () => {
        const [iface, container] = makeInterface();
        column(container);
        const [b1] = makeCell();
        const [b2, entry2] = makeCell();
        const [pc] = makePromptCollection();
        container.append(b1, b2, pc);
        b2.status = "running";
        iface.focus.focus(promptRow(pc));

        const closed: EventTarget[] = [];
        container.addEventListener("close", (e) => closed.push(e.target!));

        key(container, "keydown", { key: "q", ctrlKey: true });
        key(container, "keydown", { key: "k", ctrlKey: true });
        key(container, "keydown", { key: "d", ctrlKey: true });
        expect(Array.from(iface.interactions.purge())).toEqual([
            { type: "user_signal", code: 15, entry: entry2 },
        ]);
        expect(closed).toEqual([b2]);
        // The focus stays on the prompt.
        expect(iface.focus.current).toBe(promptRow(pc));
        iface.keys.detach();
    });

    test("the focused cell holds the DOM focus; releasing Ctrl moves it into the terminal", () => {
        const [iface, container] = makeInterface();
        column(container);
        const [b1] = makeCell();
        const term = document.createElement("embedded-term");
        let focused = 0;
        term.focus = () => {
            focused++;
        };
        b1.setView("pty", term);
        container.append(b1);

        key(container, "keydown", { key: "q", ctrlKey: true });
        expect(iface.focus.holdCommits).toBe(true);
        key(container, "keydown", { key: "ArrowDown", ctrlKey: true });
        expect(document.activeElement).toBe(b1);
        expect(b1.tabIndex).toBe(-1);
        expect(focused).toBe(0);

        key(window, "keyup", { key: "Control" });
        expect(iface.keys.capturing).toBe(false);
        expect(iface.focus.holdCommits).toBe(false);
        expect(focused).toBe(1);
        iface.keys.detach();
    });

    test("'l' clears spent cells — C-q-l or plain Ctrl+L", () => {
        const [iface, container] = makeInterface();
        const [doneBox] = makeCell();
        const [errBox] = makeCell();
        const [runBox] = makeCell();
        doneBox.status = "done";
        errBox.status = "error";
        runBox.status = "running";
        container.append(doneBox, errBox, runBox);

        key(container, "keydown", { key: "q", ctrlKey: true });
        key(container, "keydown", { key: "l", ctrlKey: true });
        key(window, "keyup", { key: "Control" });
        expect(doneBox.isConnected).toBe(false);
        expect(errBox.isConnected).toBe(false);
        expect(runBox.isConnected).toBe(true);

        // Plain Ctrl+L clears only in a prompt input, and is swallowed there.
        const [pc] = makePromptCollection();
        const [late] = makeCell();
        late.status = "done";
        container.append(late, pc);

        // Elsewhere it passes through (a pty's clear-screen stays intact).
        const past = key(container, "keydown", { key: "l", ctrlKey: true });
        expect(past.defaultPrevented).toBe(false);
        expect(late.isConnected).toBe(true);

        const editor = pc.querySelector<HTMLElement>(".stub-editor")!;
        const ev = key(editor, "keydown", { key: "l", ctrlKey: true });
        expect(ev.defaultPrevented).toBe(true);
        expect(late.isConnected).toBe(false);
        expect(runBox.isConnected).toBe(true);
        iface.keys.detach();
    });

    test("Mod+p and Ctrl+Q p focus the latest prompt in the history", () => {
        const [iface, container] = makeInterface();
        column(container);
        const [pc1] = makePromptCollection();
        const [b1] = makeCell();
        const [pc2] = makePromptCollection();
        container.append(pc1, b1, pc2);
        const mod = isMac() ? { metaKey: true } : { ctrlKey: true };

        // No prompt in the history yet: nothing to go back to.
        key(container, "keydown", { key: "p", ...mod });
        expect(iface.focus.current).toBeNull();

        iface.focus.focus(promptRow(pc2));
        iface.focus.focus(b1);
        key(container, "keydown", { key: "p", ...mod });
        expect(iface.focus.current).toBe(promptRow(pc2));

        iface.focus.focus(b1);
        key(container, "keydown", { key: "q", ctrlKey: true });
        key(container, "keydown", { key: "p", ctrlKey: true });
        expect(iface.focus.current).toBe(promptRow(pc2));
        iface.keys.detach();
    });

    test("the latest prompt is remembered beyond the history size", () => {
        const [iface, container] = makeInterface();
        const [pc] = makePromptCollection();
        const cells = Array.from({ length: 15 }, () => makeCell()[0]);
        container.append(pc, ...cells);

        iface.focus.focus(promptRow(pc), "click");
        for (const cell of cells) {
            iface.focus.focus(cell, "click");
        }
        const mod = isMac() ? { metaKey: true } : { ctrlKey: true };
        key(container, "keydown", { key: "p", ...mod });
        expect(iface.focus.current).toBe(promptRow(pc));
        iface.keys.detach();
    });
});
