// @vitest-environment happy-dom

import { afterEach, describe, expect, test } from "vitest";
import { calculateStyle, styleToCss } from "../../src/color.ts";
import type {
    EditorFactory,
    PromptCollection,
    StyleSpan,
} from "../../src/components/prompt-collection.tsx";
import "../../src/components/prompt-collection.tsx";

afterEach(() => {
    document.body.replaceChildren();
});

// A lightweight stand-in for the CodeMirror editor so tests don't construct a
// real EditorView (which needs layout). Records destruction and change calls.
const destroyed: string[] = [];
// The editor handle, plus a test hook to fire the navigation callback that the
// real CodeMirror editor binds to Cmd/Ctrl-Left/Right.
type StubEditor = ReturnType<EditorFactory> & {
    navigate?: (dir: -1 | 1) => void;
    /** Last spans/base-style/position handed to the editor, for assertions. */
    spans?: StyleSpan[];
    baseStyle?: string;
    position?: number;
};

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
            setHighlights: (spans) => {
                editor.spans = spans;
            },
            setBaseStyle: (css) => {
                editor.baseStyle = css;
            },
            setPosition: (position) => {
                editor.position = position;
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
            color: "green",
            promptHtml: "<b>$</b>",
            doc: "ls",
        });

        // Marker holds the prompt HTML, to the left; editor holds the stub editor.
        const r = row(pc, id)!;
        expect(r.querySelector(".prompt-collection-marker")?.innerHTML).toBe("<b>$</b>");
        expect(r.querySelector(".prompt-collection-editor .stub-editor")?.textContent).toBe("ls");

        // The active tab wears its accent, resolved through the color grammar.
        const t = tab(pc, id)!;
        expect(t.textContent).toBe("sh");
        expect(t.getAttribute("style")).toBe(styleToCss(calculateStyle("green", pc.anchors)));
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
        const id = pc.addPrompt({ label: "a", color: "blue", promptHtml: "$" });
        pc.setLabel(id, "renamed");
        pc.setColor(id, "red");
        pc.setPromptHtml(id, "<i>&gt;</i>");
        expect(tab(pc, id)?.textContent).toBe("renamed");
        // Active tab: accent resolved via the color grammar.
        expect(tab(pc, id)?.getAttribute("style")).toBe(
            styleToCss(calculateStyle("red", pc.anchors)),
        );
        expect(row(pc, id)?.querySelector(".prompt-collection-marker")?.innerHTML).toBe(
            "<i>&gt;</i>",
        );
    });

    test("active tab wears its accent; inactive tabs are grey", () => {
        const pc = make();
        const a = pc.addPrompt({ label: "a", color: "green" });
        const b = pc.addPrompt({ label: "b", color: "blue" });

        const grey = styleToCss(calculateStyle("grey", pc.anchors));

        // 'a' is active (its accent), 'b' is inactive (grey) — even though it has one.
        expect(tab(pc, a)?.getAttribute("style")).toBe(
            styleToCss(calculateStyle("green", pc.anchors)),
        );
        expect(tab(pc, b)?.getAttribute("style")).toBe(grey);

        // Switch: the accents follow the active tab.
        pc.showPrompt(b);
        expect(tab(pc, a)?.getAttribute("style")).toBe(grey);
        expect(tab(pc, b)?.getAttribute("style")).toBe(
            styleToCss(calculateStyle("blue", pc.anchors)),
        );
    });

    test("an accent may carry style beyond color (e.g. bold)", () => {
        const pc = make();
        const id = pc.addPrompt({ label: "a", color: "red bold" });
        const css = tab(pc, id)?.getAttribute("style") ?? "";
        expect(css).toContain("font-weight: bold");
        expect(css).toContain("color: oklch(");
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

describe("prompt-collection — styled values", () => {
    test("setValue with StyledText sets text, colorizes ranges and moves the cursor", () => {
        const pc = make();
        const id = pc.addPrompt({ label: "a" });
        const editor = pc.getEditor(id) as StubEditor;

        pc.setValue(id, {
            text: "git commit",
            ranges: [
                { start: 0, end: 3, style: "green bold" },
                { start: 4, end: 10, style: "blue" },
            ],
            position: 4,
        });

        // Text goes through the editor.
        expect(pc.getValue(id)).toBe("git commit");

        // Ranges are resolved into concrete CSS spans via the color grammar.
        // Explicit numeric boundaries are closed (not inclusive).
        expect(editor.spans).toEqual([
            {
                start: 0,
                end: 3,
                css: styleToCss(calculateStyle("green bold", pc.anchors)),
                inclusiveStart: false,
                inclusiveEnd: false,
            },
            {
                start: 4,
                end: 10,
                css: styleToCss(calculateStyle("blue", pc.anchors)),
                inclusiveStart: false,
                inclusiveEnd: false,
            },
        ]);
        // The green span really is bold + colored.
        expect(editor.spans?.[0].css).toContain("font-weight: bold");
        expect(editor.spans?.[0].css).toContain("color: oklch(");

        // The cursor position is forwarded.
        expect(editor.position).toBe(4);
    });

    test("a partially-open boundary resolves to the text edge and marks the span open", () => {
        const pc = make();
        const id = pc.addPrompt({ label: "a" });
        const editor = pc.getEditor(id) as StubEditor;

        pc.setValue(id, {
            text: "abcdef",
            ranges: [
                { start: null, end: 3, style: "blue" }, // open start only
                { start: 3, end: null, style: "green" }, // open end only
            ],
        });

        expect(editor.spans).toEqual([
            {
                start: 0,
                end: 3,
                css: styleToCss(calculateStyle("blue", pc.anchors)),
                inclusiveStart: true,
                inclusiveEnd: false,
            },
            {
                start: 3,
                end: 6,
                css: styleToCss(calculateStyle("green", pc.anchors)),
                inclusiveStart: false,
                inclusiveEnd: true,
            },
        ]);
        // No fully-open range → no base style.
        expect(editor.baseStyle).toBe("");
    });

    test("a fully-open range becomes a whole-editor base style, not a span", () => {
        const pc = make();
        const id = pc.addPrompt({ label: "a" });
        const editor = pc.getEditor(id) as StubEditor;

        pc.setValue(id, {
            text: "abcdef",
            ranges: [
                { start: null, end: null, style: "red bold" }, // whole editor + future text
                { start: 0, end: 3, style: "blue" }, // a normal span on top
            ],
        });

        expect(editor.baseStyle).toBe(styleToCss(calculateStyle("red bold", pc.anchors)));
        expect(editor.spans).toEqual([
            {
                start: 0,
                end: 3,
                css: styleToCss(calculateStyle("blue", pc.anchors)),
                inclusiveStart: false,
                inclusiveEnd: false,
            },
        ]);
    });

    test("a fully-open range styles even an empty prompt (nothing to anchor a span to)", () => {
        const pc = make();
        const id = pc.addPrompt({ label: "a" });
        const editor = pc.getEditor(id) as StubEditor;

        pc.setValue(id, { text: "", ranges: [{ start: null, end: null, style: "green" }] });

        expect(pc.getValue(id)).toBe("");
        expect(editor.baseStyle).toBe(styleToCss(calculateStyle("green", pc.anchors)));
        expect(editor.spans).toEqual([]);
    });

    test("a plain string leaves highlights and position untouched", () => {
        const pc = make();
        const id = pc.addPrompt({ label: "a" });
        const editor = pc.getEditor(id) as StubEditor;

        pc.setValue(id, "plain");

        expect(pc.getValue(id)).toBe("plain");
        expect(editor.spans).toBeUndefined();
        expect(editor.position).toBeUndefined();
    });

    test("omitting position does not move the cursor", () => {
        const pc = make();
        const id = pc.addPrompt({ label: "a" });
        const editor = pc.getEditor(id) as StubEditor;

        pc.setValue(id, { text: "hello", ranges: [], position: null });

        expect(pc.getValue(id)).toBe("hello");
        expect(editor.spans).toEqual([]);
        expect(editor.position).toBeUndefined();
    });

    test("ranges with an unparseable accent are skipped, not fatal", () => {
        const pc = make();
        const id = pc.addPrompt({ label: "a" });
        const editor = pc.getEditor(id) as StubEditor;

        pc.setValue(id, {
            text: "abcdef",
            ranges: [
                { start: 0, end: 2, style: "chartreuse" }, // unknown color → skipped
                { start: 2, end: 4, style: "red" },
            ],
        });

        expect(editor.spans).toEqual([
            {
                start: 2,
                end: 4,
                css: styleToCss(calculateStyle("red", pc.anchors)),
                inclusiveStart: false,
                inclusiveEnd: false,
            },
        ]);
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
