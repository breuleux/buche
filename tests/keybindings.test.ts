// @vitest-environment happy-dom

import { afterEach, describe, expect, test } from "vitest";
import { BucheGui } from "../src/components/buche-gui.tsx";
import type { EchoBox } from "../src/components/echo-box.tsx";
import type { EditorFactory, PromptCollection } from "../src/components/prompt-collection.tsx";
import type { BucheConfig } from "../src/config.ts";
import { Buche, type InM } from "../src/core.ts";
import { Entry } from "../src/entry.ts";
import { BucheInterface } from "../src/interface.tsx";
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
    function setup(bindings: unknown[]) {
        const container = document.createElement("div");
        document.body.append(container);
        const iface = new BucheInterface({ container, config: { bindings } });
        return { iface, container };
    }

    test("the user's rules over the defaults: another key for nav, a new global", () => {
        const { iface, container } = setup([
            { key: "alt+q", action: "-setMode" },
            { key: "ctrl+e", action: "setMode", args: { mode: "nav", hold: "ctrl" } },
            { key: "alt+n", action: "nextTab" },
            // Over the default T (renameWindow), in nav mode.
            { key: "t", action: "kill", when: "mode == nav" },
        ]);
        const calls: string[] = [];
        iface.killCell = () => calls.push("kill");
        iface.cycleTabs = (forward) => calls.push(forward ? "next" : "prev");

        // Alt+Q no longer enters navigation mode; Ctrl+E does.
        key(container, "keydown", { key: "Alt", code: "AltLeft", altKey: true });
        key(container, "keydown", { key: "q", code: "KeyQ", altKey: true });
        expect(iface.nav.mode).toBe("off");
        key(container, "keyup", { key: "Alt", code: "AltLeft" });

        key(container, "keydown", { key: "Control", code: "ControlLeft", ctrlKey: true });
        key(container, "keydown", { key: "e", code: "KeyE", ctrlKey: true });
        expect(iface.nav.mode).toBe("held");
        expect(iface.keys.mode).toBe("nav");
        key(container, "keydown", { key: "t", code: "KeyT", ctrlKey: true });
        key(container, "keyup", { key: "Control", code: "ControlLeft" });
        expect(iface.nav.mode).toBe("off");

        key(container, "keydown", { key: "n", code: "KeyN", altKey: true });
        expect(calls).toEqual(["kill", "next"]);
        // GUIs hand both chords over, not the old one.
        const chords = BucheGui.defaultInterceptChords();
        expect(chords).toEqual(expect.arrayContaining(["Ctrl+KeyE", "Alt+KeyN"]));
        expect(chords).not.toContain("Alt+KeyQ");
        iface.keys.detach();
    });

    test("another mode: on its own, with its own bindings", () => {
        const { iface, container } = setup([
            { key: "alt+w", action: "setMode", args: { mode: "move", hold: "alt" } },
            { key: "t", action: "kill", when: "mode == move" },
            { key: "w", action: "focusPrompt", when: "mode == nav" },
        ]);
        const calls: string[] = [];
        iface.renameWindow = () => calls.push("rename");
        iface.focusPrompt = () => calls.push("prompt");
        iface.killCell = () => calls.push("kill");
        const down = (k: string) =>
            key(container, "keydown", { key: k, code: `Key${k.toUpperCase()}`, altKey: true });
        const release = () => key(container, "keyup", { key: "Alt", code: "AltLeft" });
        key(container, "keydown", { key: "Alt", code: "AltLeft", altKey: true });

        // Alt+W: the move mode; T there is its own.
        down("w");
        expect(iface.keys.mode).toBe("move");
        expect(iface.nav.mode).toBe("held");
        down("t");
        release();
        expect(iface.keys.mode).toBe("");

        // Alt+Q: the nav mode; W there is nav's binding, not the move mode.
        key(container, "keydown", { key: "Alt", code: "AltLeft", altKey: true });
        down("q");
        expect(iface.keys.mode).toBe("nav");
        down("w");
        expect(iface.keys.mode).toBe("nav");
        down("t");
        release();
        expect(calls).toEqual(["kill", "prompt", "rename"]);
        expect(BucheGui.defaultInterceptChords()).toEqual(
            expect.arrayContaining(["Alt+KeyQ", "Alt+KeyW"]),
        );
        iface.keys.detach();
    });

    test("out of a mode, layout operations can be bound too", () => {
        const { iface, container } = setup([{ key: "ctrl+alt+u", action: "undo" }]);
        const ran: string[] = [];
        iface.nav.run = (action) => {
            ran.push(String(action));
        };
        key(container, "keydown", { key: "u", code: "KeyU", ctrlKey: true, altKey: true });
        expect(ran).toEqual(["undo"]);
        iface.keys.detach();
    });
});

describe("bindings from inside a GUI iframe", () => {
    /** An interface with a <buche-gui>, and a way to post as its iframe. */
    function guiInterface(config: BucheConfig | undefined) {
        const container = document.createElement("div");
        document.body.append(container);
        const iface = new BucheInterface({ container, config });
        const gui = document.createElement("buche-gui") as BucheGui;
        container.append(gui);
        const frame = gui.querySelector("iframe") ?? gui.shadowRoot?.querySelector("iframe");
        const fromFrame = (data: Record<string, unknown>) =>
            window.dispatchEvent(
                new MessageEvent("message", { source: frame?.contentWindow, data }),
            );
        return { iface, gui, fromFrame };
    }

    test("the bindings that can apply in a frame are handed over", () => {
        const { iface } = guiInterface({
            bindings: [
                { key: "ctrl+k", action: "kill", when: "inFrame" },
                { key: "ctrl+j", action: "kill", when: "inPTY || !inFrame" },
            ],
        });
        const mod = isMac() ? "Meta" : "Ctrl";
        const chords = BucheGui.defaultInterceptChords();
        expect(chords).toEqual(
            expect.arrayContaining(["Alt+KeyQ", `${mod}+KeyP`, "Ctrl+Tab", "Ctrl+KeyK"]),
        );
        // In a prompt only, in a mode only, or not in a frame: not.
        expect(chords).not.toContain("Ctrl+KeyL");
        expect(chords).not.toContain("ArrowLeft");
        expect(chords).not.toContain("Ctrl+KeyJ");
        iface.keys.detach();
    });

    test("a binding in a frame: its condition holds there", () => {
        const { iface, gui, fromFrame } = guiInterface({
            bindings: [{ key: "ctrl+k", action: "kill", when: "inFrame" }],
        });
        const calls: string[] = [];
        iface.killCell = () => calls.push("kill");
        fromFrame({
            "buche-gui": "keydown",
            type: "keydown",
            key: "k",
            code: "KeyK",
            ctrlKey: true,
        });
        expect(calls).toEqual(["kill"]);
        expect(gui).toBeTruthy();
        iface.keys.detach();
    });

    test("a modifier's side is known from a key pressed in the iframe", () => {
        const { iface, gui, fromFrame } = guiInterface({
            bindings: [
                { key: "alt+q", action: "-setMode" },
                { key: "alt+q", action: "setMode", args: { mode: "nav", hold: "altleft" } },
            ],
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

describe("inherited prompt bindings", () => {
    function setup() {
        const container = document.createElement("div");
        document.body.append(container);
        const iface = new BucheInterface({ container });
        const sent: Record<string, unknown>[] = [];
        const buche: Buche = new Buche({
            sendDriver: (m) => sent.push(m as unknown as Record<string, unknown>),
            sendInterface: (m) => iface.processMessage(buche, m),
        });
        const driver = (m: Record<string, unknown>) =>
            buche.handle({ to: ["$term"], ...m } as InM);
        const commands = () => {
            // (What the interface queued, the core handles.)
            for (const m of iface.interactions.purge()) {
                buche.handle(m as InM);
            }
            return sent.filter((m) => m.type === "command");
        };
        const boxOf = (from: string[]) => iface.layout.boxOf(buche.get(from))!;
        const ctrl = (target: EventTarget, k: string) =>
            key(target, "keydown", { key: k, code: `Key${k.toUpperCase()}`, ctrlKey: true });
        return { iface, buche, driver, commands, boxOf, ctrl };
    }
    const SEL = { command: "@pop sel", inherit: true };

    test("fired in a cell under the prompt: to the prompt, anchored on the cell", () => {
        const { iface, driver, commands, boxOf, ctrl } = setup();
        driver({
            type: "configure",
            kind: "prompt",
            from: SHELL,
            bindings: { "Ctrl+B": SEL, "Ctrl+J": { command: "mine" } },
        });
        const cell = [...SHELL, "1", "$stdout"];
        driver({ type: "configure", kind: "terminal", from: cell });
        const box = boxOf(cell);

        const ev = ctrl(box, "b");
        expect(ev.defaultPrevented).toBe(true);
        expect(commands()).toEqual([
            {
                type: "command",
                from: ["$term"],
                to: SHELL,
                text: "",
                selection: { start: 0, end: 0 },
                action: SEL,
                id: expect.any(String),
                anchor: cell,
            },
        ]);
        // Not inherited: the prompt's own only.
        expect(ctrl(box, "j").defaultPrevented).toBe(false);
        // Nor outside the prompt's address.
        const other = ["$proc", "other", "$stdout"];
        driver({ type: "configure", kind: "terminal", from: other });
        expect(ctrl(boxOf(other), "b").defaultPrevented).toBe(false);
        expect(commands()).toHaveLength(1);
        iface.keys.detach();
    });

    test("the closest prompt's wins; in a prompt, its own bindings", () => {
        const { iface, buche, driver, commands, boxOf, ctrl } = setup();
        driver({ type: "configure", kind: "prompt", from: SHELL, bindings: { "Ctrl+B": SEL } });
        const sub = [...SHELL, "1", "cq"];
        driver({
            type: "configure",
            kind: "prompt",
            from: sub,
            bindings: { "Ctrl+B": { command: "sub-sel", inherit: true } },
        });
        const cell = [...sub, "2", "$stdout"];
        driver({ type: "configure", kind: "terminal", from: cell });
        ctrl(boxOf(cell), "b");
        expect(commands().map((c) => [c.to, (c.action as { command: string }).command])).toEqual([
            [sub, "sub-sel"],
        ]);
        // In the sub-prompt itself, Ctrl+B is its own (it fires it, with its text).
        const row = iface.layout.promptElement(buche.get(sub))!;
        ctrl(row, "b");
        expect(commands()).toHaveLength(2);
        expect(commands()[1]).toMatchObject({ to: sub, action: { command: "sub-sel" } });
        expect(commands()[1].anchor).toBeUndefined();
        iface.keys.detach();
    });

    test("the keymap's rules come first", () => {
        const { iface, driver, commands, boxOf, ctrl } = setup();
        // (Ctrl+Tab: nextTab, by default.)
        driver({ type: "configure", kind: "prompt", from: SHELL, bindings: { "Ctrl+Tab": SEL } });
        const cell = [...SHELL, "1", "$stdout"];
        driver({ type: "configure", kind: "terminal", from: cell });
        key(boxOf(cell), "keydown", { key: "Tab", code: "Tab", ctrlKey: true });
        expect(commands()).toEqual([]);
        expect(ctrl).toBeTruthy();
        iface.keys.detach();
    });

    test("a GUI under the prompt hands the inherited chords over", () => {
        const { iface, driver } = setup();
        driver({ type: "configure", kind: "prompt", from: SHELL, bindings: { "Ctrl+B": SEL } });
        const cell = [...SHELL, "1", "$stdout"];
        driver({ type: "configure", kind: "frame", from: cell });
        driver({ type: "send", from: cell, message: { type: "data", data: {} } });
        const gui = document.querySelector<BucheGui>("buche-gui")!;
        expect(gui.interceptChords()).toContain("Ctrl+B");
        // The bindings are read as they are when the focus enters it.
        driver({ type: "configure", kind: "prompt", from: SHELL, bindings: { "Ctrl+O": SEL } });
        expect(gui.interceptChords()).toContain("Ctrl+O");
        expect(gui.interceptChords()).not.toContain("Ctrl+B");
        iface.keys.detach();
    });
});
