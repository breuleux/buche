// @vitest-environment happy-dom

import { afterEach, describe, expect, test } from "vitest";
import type { EditorFactory, PromptCollection } from "../../src/components/prompt-collection.tsx";
import "../../src/components/prompt-collection.tsx";

afterEach(() => {
    document.body.replaceChildren();
});

// A lightweight stand-in for the CodeMirror editor so tests don't construct a
// real EditorView (which needs layout). Records destruction and change calls.
const destroyed: string[] = [];
// The editor handle, plus a test hook to fire the navigation callback that the
// real CodeMirror editor binds to Cmd/Ctrl-Left/Right.
type StubEditor = ReturnType<EditorFactory> & { navigate?: (dir: -1 | 1) => void };

function stubFactory(): EditorFactory {
    return ({ doc, onChange, onNavigate }) => {
        let value = doc;
        const dom = document.createElement("div");
        dom.className = "stub-editor";
        dom.textContent = value;
        const editor: StubEditor = {
            dom,
            getValue: () => value,
            setValue: (v) => {
                value = v;
                dom.textContent = v;
                onChange?.(v);
            },
            focus: () => {},
            destroy: () => {
                destroyed.push(value);
                dom.remove();
            },
            navigate: onNavigate,
        };
        return editor;
    };
}

function make(): PromptCollection {
    const pc = document.createElement("prompt-collection") as PromptCollection;
    pc.editorFactory = stubFactory();
    document.body.append(pc);
    return pc;
}

const tabs = (pc: PromptCollection) =>
    Array.from(pc.querySelectorAll<HTMLElement>(".prompt-collection-tab"));
const tab = (pc: PromptCollection, id: string) =>
    pc.querySelector<HTMLElement>(`.prompt-collection-tab[data-prompt="${id}"]`);
const row = (pc: PromptCollection, id: string) =>
    pc.querySelector<HTMLElement>(`.prompt-collection-prompt[data-prompt="${id}"]`);

describe("prompt-collection — structure", () => {
    test("builds a prompts container and a tab zone", () => {
        const pc = make();
        expect(pc.querySelector(".prompt-collection-prompts")).not.toBeNull();
        expect(pc.querySelector(".prompt-collection-tabs")).not.toBeNull();
    });
});

describe("prompt-collection — adding prompts", () => {
    test("creates an editor, a leading marker and a coloured tab; first is active", () => {
        const pc = make();
        const id = pc.addPrompt({
            label: "sh",
            color: "#8ae234",
            promptHtml: "<b>$</b>",
            doc: "ls",
        });

        // Marker holds the prompt HTML, to the left; editor holds the stub editor.
        const r = row(pc, id)!;
        expect(r.querySelector(".prompt-collection-marker")?.innerHTML).toBe("<b>$</b>");
        expect(r.querySelector(".prompt-collection-editor .stub-editor")?.textContent).toBe("ls");

        // Tab shows the label in the configured colour.
        const t = tab(pc, id)!;
        expect(t.textContent).toBe("sh");
        expect(t.style.color).toBe("#8ae234");
        expect(t.draggable).toBe(true);

        // First prompt is active and shown.
        expect(pc.activePrompt).toBe(id);
        expect(r.hidden).toBe(false);
        expect(t.classList.contains("active")).toBe(true);
        expect(t.getAttribute("aria-selected")).toBe("true");
    });

    test("additional prompts start hidden", () => {
        const pc = make();
        pc.addPrompt({ label: "a" });
        const b = pc.addPrompt({ label: "b" });
        expect(row(pc, b)?.hidden).toBe(true);
        expect(pc.prompts.length).toBe(2);
    });

    test("rejects duplicate ids", () => {
        const pc = make();
        pc.addPrompt({ id: "x", label: "a" });
        expect(() => pc.addPrompt({ id: "x", label: "b" })).toThrow();
    });
});

describe("prompt-collection — switching", () => {
    test("clicking a tab activates its prompt and fires promptchange", () => {
        const pc = make();
        const a = pc.addPrompt({ label: "a" });
        const b = pc.addPrompt({ label: "b" });
        const events: string[] = [];
        pc.addEventListener("promptchange", (e) => {
            events.push((e as CustomEvent<{ prompt: string }>).detail.prompt);
        });

        tab(pc, b)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

        expect(pc.activePrompt).toBe(b);
        expect(row(pc, a)?.hidden).toBe(true);
        expect(row(pc, b)?.hidden).toBe(false);
        expect(tab(pc, b)?.classList.contains("active")).toBe(true);
        expect(tab(pc, a)?.classList.contains("active")).toBe(false);
        expect(events).toEqual([b]);
    });
});

describe("prompt-collection — per-prompt config", () => {
    test("setLabel, setColor and setPromptHtml update the DOM", () => {
        const pc = make();
        const id = pc.addPrompt({ label: "a", color: "#111", promptHtml: "$" });
        pc.setLabel(id, "renamed");
        pc.setColor(id, "#f00");
        pc.setPromptHtml(id, "<i>&gt;</i>");
        expect(tab(pc, id)?.textContent).toBe("renamed");
        expect(tab(pc, id)?.style.color).toBe("#f00");
        expect(row(pc, id)?.querySelector(".prompt-collection-marker")?.innerHTML).toBe(
            "<i>&gt;</i>",
        );
    });
});

describe("prompt-collection — editor values", () => {
    test("getValue / setValue go through the editor and fire onChange", () => {
        const pc = make();
        const changes: string[] = [];
        const id = pc.addPrompt({ label: "a", doc: "one", onChange: (v) => changes.push(v) });
        expect(pc.getValue(id)).toBe("one");
        pc.setValue(id, "two");
        expect(pc.getValue(id)).toBe("two");
        expect(changes).toEqual(["two"]);
    });
});

describe("prompt-collection — reordering", () => {
    test("movePrompt reorders the tabs and fires reorder", () => {
        const pc = make();
        const a = pc.addPrompt({ label: "a" });
        const b = pc.addPrompt({ label: "b" });
        const c = pc.addPrompt({ label: "c" });
        const events: string[][] = [];
        pc.addEventListener("reorder", (e) => {
            events.push((e as CustomEvent<{ order: string[] }>).detail.order);
        });

        pc.movePrompt(c, 0); // c to the front

        expect(pc.prompts).toEqual([c, a, b]);
        expect(tabs(pc).map((t) => t.getAttribute("data-prompt"))).toEqual([c, a, b]);
        expect(events).toEqual([[c, a, b]]);
    });
});

describe("prompt-collection — focus rotation", () => {
    test("Cmd-Left / Cmd-Right rotate the active prompt cyclically", () => {
        const pc = make();
        const a = pc.addPrompt({ label: "a" });
        const b = pc.addPrompt({ label: "b" });
        const c = pc.addPrompt({ label: "c" });
        // Fire the navigation callback of the currently-active prompt's editor,
        // as Cmd/Ctrl-Left/Right would in the real CodeMirror editor.
        const nav = (dir: -1 | 1) =>
            (pc.getEditor(pc.activePrompt!) as StubEditor).navigate?.(dir);

        expect(pc.activePrompt).toBe(a);
        nav(1);
        expect(pc.activePrompt).toBe(b);
        nav(1);
        expect(pc.activePrompt).toBe(c);
        nav(1);
        expect(pc.activePrompt).toBe(a); // wraps forward
        nav(-1);
        expect(pc.activePrompt).toBe(c); // wraps backward
    });

    test("rotation is a no-op with a single prompt", () => {
        const pc = make();
        const a = pc.addPrompt({ label: "a" });
        (pc.getEditor(a) as StubEditor).navigate?.(1);
        expect(pc.activePrompt).toBe(a);
    });
});

describe("prompt-collection — removing", () => {
    test("removePrompt drops it, destroys its editor and activates the next", () => {
        const pc = make();
        const a = pc.addPrompt({ label: "a", doc: "aa" });
        const b = pc.addPrompt({ label: "b" });
        destroyed.length = 0;

        pc.removePrompt(a); // 'a' was active

        expect(pc.prompts).toEqual([b]);
        expect(tab(pc, a)).toBeNull();
        expect(row(pc, a)).toBeNull();
        expect(destroyed).toEqual(["aa"]); // editor.destroy() was called
        expect(pc.activePrompt).toBe(b);
        expect(row(pc, b)?.hidden).toBe(false);
    });
});

describe("prompt-collection — authored prompts", () => {
    test("adopts authored [data-label] children as prompts", () => {
        const pc = document.createElement("prompt-collection") as PromptCollection;
        pc.editorFactory = stubFactory();
        const sh = document.createElement("div");
        sh.setAttribute("data-label", "sh");
        sh.setAttribute("data-color", "#8ae234");
        sh.innerHTML = "<b>$</b>";
        const py = document.createElement("div");
        py.setAttribute("data-label", "py");
        pc.append(sh, py);
        document.body.append(pc);

        expect(pc.prompts.length).toBe(2);
        expect(tabs(pc).map((t) => t.textContent)).toEqual(["sh", "py"]);
        const firstId = pc.prompts[0];
        expect(row(pc, firstId)?.querySelector(".prompt-collection-marker")?.innerHTML).toBe(
            "<b>$</b>",
        );
    });
});
