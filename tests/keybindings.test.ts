// @vitest-environment happy-dom

import { afterEach, describe, expect, test } from "vitest";
import { BucheGui } from "../src/components/buche-gui.tsx";
import type { EchoBox } from "../src/components/echo-box.tsx";
import type { EditorFactory, PromptCollection } from "../src/components/prompt-collection.tsx";
import type { BucheConfig } from "../src/config.ts";
import { Buche, type InM } from "../src/core.ts";
import { Entry } from "../src/entry.ts";
import { BucheInterface } from "../src/interface.tsx";
import { GlobalKeys } from "../src/keybindings.ts";
import { isMac } from "../src/keychord.ts";
import "../src/components/echo-box.tsx";
import "../src/components/prompt-collection.tsx";
import type { PromptCell } from "../src/cells/prompt.ts";

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

describe("GlobalKeys", () => {
    test("chords fire and are swallowed", () => {
        const box = document.createElement("div");
        document.body.append(box);
        const hits: string[] = [];
        const keys = new GlobalKeys({
            "Ctrl+p": () => {
                hits.push("p");
            },
        });
        keys.attach();

        const ev = key(box, "keydown", { key: "p", ctrlKey: true });
        expect(hits).toEqual(["p"]);
        expect(ev.defaultPrevented).toBe(true);

        // Wrong modifier set → no match.
        key(box, "keydown", { key: "p", ctrlKey: true, metaKey: true });
        expect(hits).toEqual(["p"]);
        keys.detach();
    });

    test("a handler returning false lets the key through", () => {
        const box = document.createElement("div");
        document.body.append(box);
        const keys = new GlobalKeys({ "Ctrl+l": () => false });
        keys.attach();
        expect(key(box, "keydown", { key: "l", ctrlKey: true }).defaultPrevented).toBe(false);
        keys.detach();
    });

    test("keys are seen even when the DOM focus is outside the interface", () => {
        // After a click in empty space the DOM focus sits on `body`: keydowns
        // from there never go through the container — the window listener
        // still sees them.
        document.body.append(document.createElement("div"));
        const hits: string[] = [];
        const keys = new GlobalKeys({
            "Ctrl+p": () => {
                hits.push("p");
            },
        });
        keys.attach();

        key(document.body, "keydown", { key: "p", ctrlKey: true });
        expect(hits).toEqual(["p"]);
        keys.detach();
    });

    test("Mod expands per-platform in chords", () => {
        const box = document.createElement("div");
        document.body.append(box);
        let hits = 0;
        const keys = new GlobalKeys({
            "Mod+p": () => {
                hits++;
            },
        });
        keys.attach();
        key(box, "keydown", { key: "p", ...(isMac() ? { metaKey: true } : { ctrlKey: true }) });
        expect(hits).toBe(1);
        keys.detach();
    });
});

function makeInterface(): [BucheInterface, HTMLElement] {
    const container = document.createElement("div");
    document.body.append(container);
    const iface = new BucheInterface({ container });
    // (The empty "main" pane offers a slot: these tests put their own cells
    // around it, and navigate among them only.)
    for (const chooser of container.querySelectorAll("slot-chooser")) {
        chooser.removeAttribute("focusable");
    }
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
    (entry.replaceCell("prompt") as PromptCell).configurePrompt({
        input: { context: { parts: [{ text: "$" }] } },
    });
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
    test("Mod+p focuses a visible prompt, the latest one focused first", () => {
        const [iface, container] = makeInterface();
        column(container);
        const [pc1] = makePromptCollection();
        const [b1] = makeCell();
        const [pc2] = makePromptCollection();
        container.append(pc1, b1, pc2);
        const mod = isMac() ? { metaKey: true } : { ctrlKey: true };

        // No prompt in the history yet: the first one shown.
        key(container, "keydown", { key: "p", ...mod });
        expect(iface.focus.current).toBe(promptRow(pc1));

        iface.focus.focus(promptRow(pc2));
        iface.focus.focus(b1);
        key(container, "keydown", { key: "p", ...mod });
        expect(iface.focus.current).toBe(promptRow(pc2));

        iface.keys.detach();
    });

    test("Mod+p prefers a visible prompt to a hidden one focused last", () => {
        const [iface, container] = makeInterface();
        column(container);
        const hidden = document.createElement("div");
        const [pc1] = makePromptCollection();
        hidden.append(pc1);
        const [b1] = makeCell();
        const [pc2] = makePromptCollection();
        container.append(hidden, b1, pc2);
        const mod = isMac() ? { metaKey: true } : { ctrlKey: true };

        iface.focus.focus(promptRow(pc2));
        iface.focus.focus(promptRow(pc1));
        iface.focus.focus(b1);
        hidden.hidden = true;
        key(container, "keydown", { key: "p", ...mod });
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

// ── Cell actions, on cells in the layout ─────────────────────────────────────

const SHELL = ["$proc", "cq"];

/** Alt+Q, then these keys (by code), Alt held throughout, then released. */
function nav(target: EventTarget, ...codes: string[]): void {
    key(target, "keydown", { key: "Alt", code: "AltLeft", altKey: true });
    for (const code of ["KeyQ", ...codes]) {
        key(target, "keydown", {
            key: code.replace(/^Key/, "").toLowerCase(),
            code,
            altKey: true,
        });
        key(target, "keyup", { key: code.replace(/^Key/, "").toLowerCase(), code, altKey: true });
    }
    key(target, "keyup", { key: "Alt", code: "AltLeft" });
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function machineInterface() {
    const [iface, container] = makeInterface();
    const buche: Buche = new Buche({
        sendDriver: () => {},
        sendInterface: (m) => iface.processMessage(buche, m),
    });
    const driver = (m: Record<string, unknown>) => buche.handle({ to: ["$term"], ...m } as InM);
    // Cells (commands run from a prompt) with the given statuses.
    let seq = 1;
    const cells = (shell: string[], ...statuses: string[]) =>
        statuses.map((status, i) => {
            const from = [...shell, String(++seq)];
            driver({ type: "configure", kind: "frame", from, label: `c${seq}` });
            if (status !== "running") {
                driver({
                    type: "close",
                    from,
                    outcome: { type: status === "done" ? "success" : "error" },
                });
            }
            const entry = buche.get(from);
            return { entry, box: iface.layout.boxOf(entry)! };
        });
    const promptOf = (shell: string[]) => iface.layout.promptElement(buche.get(shell))!;
    return { iface, container, buche, driver, cells, promptOf };
}

describe("cell actions", () => {
    test("'k' signals the focused cell's entry", () => {
        const { iface, container, driver, cells } = machineInterface();
        driver({ type: "configure", kind: "prompt", from: SHELL, label: "cq" });
        const [{ entry, box }] = cells(SHELL, "running");
        iface.focus.focus(box);
        iface.interactions.purge();

        nav(container, "KeyK");
        // An unresponsive cell gets SIGKILL instead.
        entry.cell.status = { status: "unresponsive" };
        entry.fire();
        nav(container, "KeyK");
        const signals = [...iface.interactions.purge()].filter(
            (m: any) => m.type === "user_signal",
        );
        expect(signals).toEqual([
            { type: "user_signal", code: 15, entry },
            { type: "user_signal", code: 9, entry },
        ]);
        iface.keys.detach();
    });

    test("'p' focuses the prompt and leaves navigation, like Mod+p", () => {
        const { iface, container, driver, cells, promptOf } = machineInterface();
        driver({ type: "configure", kind: "prompt", from: SHELL, label: "cq" });
        const [{ box }] = cells(SHELL, "running");
        iface.focus.focus(promptOf(SHELL));
        iface.focus.focus(box);
        key(container, "keydown", { key: "Alt", code: "AltLeft", altKey: true });
        for (const code of ["KeyQ", "KeyP"]) {
            key(container, "keydown", { key: code.slice(3).toLowerCase(), code, altKey: true });
        }
        const q = iface.layout.promptNodeOf(iface.layout.anyPrompt()!);
        expect(iface.layout.ws.selection.id).toBe(q);
        expect(iface.nav.mode).toBe("off");
        expect(iface.focus.current).toBe(promptOf(SHELL));
        key(container, "keyup", { key: "Alt", code: "AltLeft" });
        expect(iface.focus.current).toBe(promptOf(SHELL));
        iface.keys.detach();
    });

    test("'w' closes the cell, like its tab's ✕", async () => {
        const { iface, container, driver, cells } = machineInterface();
        driver({ type: "configure", kind: "prompt", from: SHELL, label: "cq" });
        const [{ box }] = cells(SHELL, "done");
        iface.focus.focus(box);

        nav(container, "KeyW");
        await settle();
        expect(box.isConnected).toBe(false);
        iface.keys.detach();
    });

    test("from a prompt, 'k' and 'w' apply to the cell right above it", async () => {
        const { iface, container, driver, cells, promptOf } = machineInterface();
        driver({ type: "configure", kind: "prompt", from: SHELL, label: "cq" });
        const [, { entry, box }] = cells(SHELL, "done", "running");
        iface.focus.focus(promptOf(SHELL));
        iface.interactions.purge();

        nav(container, "KeyK", "KeyW");
        const signals = [...iface.interactions.purge()].filter(
            (m: any) => m.type === "user_signal",
        );
        expect(signals).toEqual([
            { type: "user_signal", code: 15, entry },
            { type: "user_signal", code: 15, entry },
        ]);
        expect(box.isConnected).toBe(true); // (closing: until its process ends)
        // The focus stays on the prompt.
        expect(iface.focus.current).toBe(promptOf(SHELL));
        iface.keys.detach();
    });

    test("'l' clears spent cells — Alt+Q L, or plain Ctrl+L in a prompt", async () => {
        const { iface, container, driver, cells, promptOf } = machineInterface();
        driver({ type: "configure", kind: "prompt", from: SHELL, label: "cq" });
        const [done, err, run] = cells(SHELL, "done", "error", "running");

        // (From the prompt: its stream.)
        iface.focus.focus(promptOf(SHELL));
        nav(container, "KeyL");
        await settle();
        expect(done.box.isConnected).toBe(false);
        expect(err.box.isConnected).toBe(false);
        expect(run.box.isConnected).toBe(true);

        const [, late] = cells(SHELL, "running", "done");
        // Elsewhere, Ctrl+L passes through (a pty's clear-screen stays intact).
        const past = key(container, "keydown", { key: "l", ctrlKey: true });
        expect(past.defaultPrevented).toBe(false);
        await settle();
        expect(late.box.isConnected).toBe(true);

        const ev = key(promptOf(SHELL), "keydown", { key: "l", ctrlKey: true });
        expect(ev.defaultPrevented).toBe(true);
        await settle();
        expect(late.box.isConnected).toBe(false);
        expect(run.box.isConnected).toBe(true);
        iface.keys.detach();
    });

    test("Ctrl+L clears only the prompt's own stream", async () => {
        const { iface, buche, driver, cells, promptOf } = machineInterface();
        const other = ["$proc", "other"];
        driver({ type: "configure", kind: "prompt", from: SHELL, label: "cq" });
        driver({ type: "configure", kind: "prompt", from: other, label: "other" });
        const [a] = cells(SHELL, "done");
        const [b] = cells(other, "done");

        iface.layout.revealPrompt(buche.get(SHELL));
        key(promptOf(SHELL), "keydown", { key: "l", ctrlKey: true });
        await settle();
        expect(a.box.isConnected).toBe(false);
        expect(b.box.isConnected).toBe(true);
        iface.keys.detach();
    });
});

describe("configured bindings", () => {
    test("a custom Nav chord, Nav binding and global binding", () => {
        const container = document.createElement("div");
        document.body.append(container);
        const iface = new BucheInterface({
            container,
            config: {
                modifiers: { Nav: "Ctrl+e" },
                bindings: { "Nav+t": "renameWindow", "Alt+n": "nextTab" },
            },
        });
        const calls: string[] = [];
        iface.renameWindow = () => calls.push("rename");
        iface.cycleTabs = (forward) => calls.push(forward ? "next" : "prev");

        // Alt+Q no longer enters navigation mode; Ctrl+E does.
        key(container, "keydown", { key: "Alt", code: "AltLeft", altKey: true });
        key(container, "keydown", { key: "q", code: "KeyQ", altKey: true });
        expect(iface.nav.mode).toBe("off");
        key(container, "keyup", { key: "Alt", code: "AltLeft" });

        key(container, "keydown", { key: "Control", code: "ControlLeft", ctrlKey: true });
        key(container, "keydown", { key: "e", code: "KeyE", ctrlKey: true });
        expect(iface.nav.mode).toBe("held");
        key(container, "keydown", { key: "t", code: "KeyT", ctrlKey: true });
        key(container, "keyup", { key: "Control", code: "ControlLeft" });
        expect(iface.nav.mode).toBe("off");

        key(container, "keydown", { key: "n", code: "KeyN", altKey: true });
        expect(calls).toEqual(["rename", "next"]);
        // GUIs hand both chords over.
        expect(BucheGui.defaultInterceptChords()).toEqual(
            expect.arrayContaining(["Ctrl+e", "Alt+n"]),
        );
        expect(BucheGui.defaultInterceptChords()).not.toContain("Alt+q");
        iface.keys.detach();
    });
});

describe("several modifiers", () => {
    test("each is a mode of its own, one on at a time", () => {
        const container = document.createElement("div");
        document.body.append(container);
        const iface = new BucheInterface({
            container,
            config: {
                modifiers: { Nav: "Alt+q", Move: "Alt+w" },
                bindings: { "Nav+t": "renameWindow", "Nav+w": "focusPrompt", "Move+t": "kill" },
            },
        });
        const calls: string[] = [];
        iface.renameWindow = () => calls.push("rename");
        iface.focusPrompt = () => calls.push("prompt");
        iface.killCell = () => calls.push("kill");
        const down = (k: string) =>
            key(container, "keydown", { key: k, code: `Key${k.toUpperCase()}`, altKey: true });
        const release = () => key(container, "keyup", { key: "Alt", code: "AltLeft" });
        key(container, "keydown", { key: "Alt", code: "AltLeft", altKey: true });

        // Alt+W: the Move mode; T there is its own.
        down("w");
        expect(iface.modes.Move.mode).toBe("held");
        expect(iface.modes.Nav.mode).toBe("off");
        expect(iface.nav).toBe(iface.modes.Move);
        down("t");
        release();
        expect(iface.modes.Move.mode).toBe("off");

        // Alt+Q: the Nav mode; W there is Nav's binding, not the Move mode.
        key(container, "keydown", { key: "Alt", code: "AltLeft", altKey: true });
        down("q");
        expect(iface.modes.Nav.mode).toBe("held");
        down("w");
        expect(iface.modes.Move.mode).toBe("off");
        down("t");
        release();
        expect(calls).toEqual(["kill", "prompt", "rename"]);
        expect(BucheGui.defaultInterceptChords()).toEqual(
            expect.arrayContaining(["Alt+q", "Alt+w"]),
        );
        iface.keys.detach();
    });
});

describe("bindings from inside a GUI iframe", () => {
    /** An interface with a <buche-gui>, and a way to post as its iframe. */
    function guiInterface(config: BucheConfig | null) {
        const container = document.createElement("div");
        document.body.append(container);
        const iface = new BucheInterface({ container, config: config ?? undefined });
        const gui = document.createElement("buche-gui") as BucheGui;
        container.append(gui);
        const frame = gui.querySelector("iframe") ?? gui.shadowRoot?.querySelector("iframe");
        const fromFrame = (data: Record<string, unknown>) =>
            window.dispatchEvent(
                new MessageEvent("message", { source: frame?.contentWindow, data }),
            );
        return { iface, gui, fromFrame };
    }

    test("every global binding but clearPrompt is handed over", () => {
        guiInterface(BucheInterface.defaultConfig);
        const mod = isMac() ? "Meta" : "Ctrl";
        const chords = BucheGui.defaultInterceptChords();
        expect(chords).toContain("Alt+q");
        expect(chords).toContain(`${mod}+p`);
        expect(chords).not.toContain("Ctrl+l");
    });

    test("a modifier's side is known from a key pressed in the iframe", () => {
        const { iface, gui, fromFrame } = guiInterface({
            modifiers: { Nav: "AltLeft+q" },
            bindings: {},
        });
        gui.focus();
        const keyMsg = (tag: string, type: string, init: Record<string, unknown>) =>
            fromFrame({
                "buche-gui": tag,
                type,
                ctrlKey: false,
                shiftKey: false,
                metaKey: false,
                ...init,
            });
        keyMsg("modifier", "keydown", { key: "Alt", code: "AltLeft", altKey: true });
        // (Reported only: the focus stays where it was.)
        expect(document.activeElement).toBe(gui);
        keyMsg("keydown", "keydown", { key: "œ", code: "KeyQ", altKey: true });
        expect(iface.nav.mode).toBe("held");
        iface.keys.detach();
    });
});
