// @vitest-environment happy-dom

import { afterEach, describe, expect, test } from "vitest";
import { styleToCss, defaultTheme as th } from "../../src/color.ts";
import type {
    EditorFactory,
    PromptCollection,
    PromptCommandDetail,
    PromptTextChangeDetail,
    StyleSpan,
} from "../../src/components/prompt-collection.tsx";
import "../../src/components/prompt-collection.tsx";
import { Entry } from "../../src/entry.ts";
import { Prompt, type PromptBindings } from "../../src/prompt.ts";
import type { StyledText } from "../../src/types.ts";

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
    filigrane?: string | null;
    readOnly?: boolean;
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
            setFiligrane: (filigrane) => {
                editor.filigrane = filigrane;
            },
            setReadOnly: (readOnly) => {
                editor.readOnly = readOnly;
            },
            getPosition: () => editor.position ?? value.length,
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

const plain = (text: string): StyledText => ({ text, ranges: [] });

// Build a prompt Entry: label + accent on its Echo; marker + content on its Prompt.
function makeEntry(
    opts: {
        label?: string;
        color?: string;
        marker?: StyledText;
        content?: StyledText;
        bindings?: PromptBindings;
    } = {},
): Entry {
    const entry = new Entry({});
    if (opts.label != null) {
        entry.echo.label = opts.label;
    }
    if (opts.color != null) {
        entry.echo.color = opts.color;
    }
    entry.setPrompt(
        new Prompt({
            prompt: opts.marker ?? { text: "", ranges: [] },
            content: opts.content ?? { text: "", ranges: [] },
            bindings: opts.bindings,
        }),
    );
    return entry;
}

const tabs = (pc: PromptCollection) =>
    Array.from(pc.querySelectorAll<HTMLElement>(".prompt-collection-tab"));
const rows = (pc: PromptCollection) =>
    Array.from(pc.querySelectorAll<HTMLElement>(".prompt-collection-prompt"));
// Tabs and rows are kept in DOM order matching `pc.prompts`, so an entry's index
// in `pc.prompts` locates its tab / row.
const tabOf = (pc: PromptCollection, entry: Entry) => tabs(pc)[pc.prompts.indexOf(entry)] ?? null;
const rowOf = (pc: PromptCollection, entry: Entry) => rows(pc)[pc.prompts.indexOf(entry)] ?? null;

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
        const entry = pc.addPrompt(
            makeEntry({
                label: "sh",
                color: "green",
                marker: { text: "$", ranges: [{ start: 0, end: 1, style: "green bold" }] },
                content: plain("ls"),
            }),
        );

        // Marker renders the Prompt's `prompt` StyledText, to the left; the editor
        // holds the Prompt's `content` text.
        const r = rowOf(pc, entry)!;
        const marker = r.querySelector(".prompt-collection-marker")!;
        expect(marker.textContent).toBe("$");
        expect(marker.querySelector(".styled-text")).not.toBeNull();
        expect(r.querySelector(".prompt-collection-editor .stub-editor")?.textContent).toBe("ls");

        // The active tab wears its Echo accent, resolved through the color grammar.
        const t = tabOf(pc, entry)!;
        expect(t.textContent).toBe("sh");
        expect(t.getAttribute("style")).toBe(styleToCss(th.calculateStyle("green")));
        expect(t.draggable).toBe(true);

        // First prompt is active and shown.
        expect(pc.activePrompt).toBe(entry);
        expect(r.hidden).toBe(false);
        expect(t.classList.contains("active")).toBe(true);
        expect(t.getAttribute("aria-selected")).toBe("true");
    });

    test("additional prompts start hidden", () => {
        const pc = make();
        pc.addPrompt(makeEntry({ label: "a" }));
        const b = pc.addPrompt(makeEntry({ label: "b" }));
        expect(rowOf(pc, b)?.hidden).toBe(true);
        expect(pc.prompts.length).toBe(2);
    });

    test("adding the same entry twice is a no-op", () => {
        const pc = make();
        const entry = makeEntry({ label: "a" });
        pc.addPrompt(entry);
        pc.addPrompt(entry);
        expect(pc.prompts).toEqual([entry]);
    });
});

describe("prompt-collection — switching", () => {
    test("clicking a tab activates its prompt and fires promptchange", () => {
        const pc = make();
        const a = pc.addPrompt(makeEntry({ label: "a" }));
        const b = pc.addPrompt(makeEntry({ label: "b" }));
        const events: Entry[] = [];
        pc.addEventListener("promptchange", (e) => {
            events.push((e as CustomEvent<{ entry: Entry }>).detail.entry);
        });

        tabOf(pc, b)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

        expect(pc.activePrompt).toBe(b);
        expect(rowOf(pc, a)?.hidden).toBe(true);
        expect(rowOf(pc, b)?.hidden).toBe(false);
        expect(tabOf(pc, b)?.classList.contains("active")).toBe(true);
        expect(tabOf(pc, a)?.classList.contains("active")).toBe(false);
        expect(events).toEqual([b]);
    });
});

describe("prompt-collection — reconfiguration", () => {
    test("firing the Entry re-reads the label, accent and marker", () => {
        const pc = make();
        const entry = pc.addPrompt(makeEntry({ label: "a", color: "blue", marker: plain("$") }));

        entry.echo.label = "renamed";
        entry.echo.color = "red";
        entry.prompt!.prompt = { text: ">", ranges: [] };
        entry.fire();

        expect(tabOf(pc, entry)?.textContent).toBe("renamed");
        // Active tab: accent resolved via the color grammar.
        expect(tabOf(pc, entry)?.getAttribute("style")).toBe(styleToCss(th.calculateStyle("red")));
        expect(rowOf(pc, entry)?.querySelector(".prompt-collection-marker")?.textContent).toBe(
            ">",
        );
    });

    test("firing the Entry resets the editor text and cursor from content", () => {
        const pc = make();
        const entry = pc.addPrompt(makeEntry({ label: "a", content: plain("first") }));
        const editor = pc.getEditor(entry) as StubEditor;
        expect(pc.getValue(entry)).toBe("first");

        // Mutate the Prompt's content and fire: the editor resets to it.
        entry.prompt!.content.text = "reset";
        entry.prompt!.content.position = 2;
        entry.fire();

        expect(pc.getValue(entry)).toBe("reset");
        expect(editor.position).toBe(2);
    });

    test("resetting from content does not feed back into content", () => {
        const pc = make();
        const entry = pc.addPrompt(makeEntry({ label: "a", content: plain("hi") }));
        entry.prompt!.content.text = "reset";
        entry.prompt!.content.position = 1;
        entry.fire();
        // The reset is applied to the editor but the stored content is preserved.
        expect(entry.prompt?.content.text).toBe("reset");
        expect(entry.prompt?.content.position).toBe(1);
    });

    test("a prompt whose echo is done or error is removed on reconfiguration", () => {
        const pc = make();
        const a = pc.addPrompt(makeEntry({ label: "a" }));
        const b = pc.addPrompt(makeEntry({ label: "b" }));
        destroyed.length = 0;

        a.echo.status = { status: "done" };
        a.fire();
        expect(pc.prompts).toEqual([b]);
        expect(tabOf(pc, a)).toBeNull();
        expect(destroyed).toEqual([""]);
        expect(pc.activePrompt).toBe(b); // 'a' was active; activation moved on

        b.echo.status = { status: "error" };
        b.fire();
        expect(pc.prompts).toEqual([]);
        expect(pc.activePrompt).toBeNull();
    });

    test("a running echo reconfigures normally", () => {
        const pc = make();
        const entry = pc.addPrompt(makeEntry({ label: "a", content: plain("keep") }));
        entry.echo.status = { status: "running" };
        entry.echo.label = "still-here";
        entry.fire();
        expect(pc.prompts).toEqual([entry]);
        expect(tabOf(pc, entry)?.textContent).toBe("still-here");
    });

    test("active tab wears its accent; inactive tabs are grey", () => {
        const pc = make();
        const a = pc.addPrompt(makeEntry({ label: "a", color: "green" }));
        const b = pc.addPrompt(makeEntry({ label: "b", color: "blue" }));

        const grey = styleToCss(th.calculateStyle("grey"));

        // 'a' is active (its accent), 'b' is inactive (grey) — even though it has one.
        expect(tabOf(pc, a)?.getAttribute("style")).toBe(styleToCss(th.calculateStyle("green")));
        expect(tabOf(pc, b)?.getAttribute("style")).toBe(grey);

        // Switch: the accents follow the active tab.
        pc.showPrompt(b);
        expect(tabOf(pc, a)?.getAttribute("style")).toBe(grey);
        expect(tabOf(pc, b)?.getAttribute("style")).toBe(styleToCss(th.calculateStyle("blue")));
    });

    test("an accent may carry style beyond color (e.g. bold)", () => {
        const pc = make();
        const entry = pc.addPrompt(makeEntry({ label: "a", color: "red bold" }));
        const css = tabOf(pc, entry)?.getAttribute("style") ?? "";
        expect(css).toContain("font-weight: bold");
        expect(css).toContain("color: oklch(");
    });
});

describe("prompt-collection — editor values", () => {
    test("the editor is seeded from the Prompt content; edits flow back to it", () => {
        const pc = make();
        const entry = pc.addPrompt(makeEntry({ label: "a", content: plain("one") }));
        expect(pc.getValue(entry)).toBe("one");

        pc.setValue(entry, "two");
        expect(pc.getValue(entry)).toBe("two");
        // Edits are synced back into the Entry's Prompt content.
        expect(entry.prompt?.content.text).toBe("two");
    });

    test("editing updates the Entry's content text and cursor position", () => {
        const pc = make();
        const entry = pc.addPrompt(makeEntry({ label: "a", content: plain("") }));
        const editor = pc.getEditor(entry) as StubEditor;

        editor.setPosition?.(3); // move the cursor
        editor.setValue("hello"); // simulate a user edit

        expect(entry.prompt?.content.text).toBe("hello");
        expect(entry.prompt?.content.position).toBe(3);
    });

    test("editing fires textchange with entry, text and position", () => {
        const pc = make();
        const entry = pc.addPrompt(makeEntry({ label: "a", content: plain("") }));
        const editor = pc.getEditor(entry) as StubEditor;

        const events: PromptTextChangeDetail[] = [];
        pc.addEventListener("textchange", (e) => {
            events.push((e as CustomEvent<PromptTextChangeDetail>).detail);
        });

        editor.setPosition?.(2);
        editor.setValue("hello");

        expect(events).toHaveLength(1);
        expect(events[0].entry).toBe(entry);
        expect(events[0].text).toBe("hello");
        expect(events[0].position).toBe(2);
    });

    test("setValue fires textchange; an entry.fire() reset does not", () => {
        const pc = make();
        const entry = pc.addPrompt(makeEntry({ label: "a", content: plain("") }));

        const events: PromptTextChangeDetail[] = [];
        pc.addEventListener("textchange", (e) => {
            events.push((e as CustomEvent<PromptTextChangeDetail>).detail);
        });

        pc.setValue(entry, "pushed");
        expect(events).toHaveLength(1);

        // Reconfiguration pushes content back into the editor; that reset must
        // not feed back as a user edit.
        entry.fire();
        expect(events).toHaveLength(1);
        expect(pc.getValue(entry)).toBe("pushed");
    });

    test("filigrane is handed to the editor on add and refreshed on reconfigure", () => {
        const pc = make();
        const entry = makeEntry({ label: "a", content: plain("ls") });
        entry.prompt!.filigrane = "ls -l";
        pc.addPrompt(entry);
        const editor = pc.getEditor(entry) as StubEditor;
        expect(editor.filigrane).toBe("ls -l");

        entry.prompt!.filigrane = null;
        entry.fire();
        expect(editor.filigrane).toBeNull();
    });
});

describe("prompt-collection — ghost text (real CodeMirror)", () => {
    test("the filigrane suffix past the text renders as ghost text", () => {
        const pc = document.createElement("prompt-collection") as PromptCollection;
        document.body.append(pc);
        const entry = makeEntry({ label: "a", content: plain("ls") });
        entry.prompt!.filigrane = "ls -l";
        pc.addPrompt(entry);
        const dom = pc.getEditor(entry)?.dom;
        expect(dom?.querySelector(".cm-filigrane")?.textContent).toBe(" -l");

        // Typing to extend the text shrinks the ghost accordingly.
        pc.setValue(entry, "ls -");
        expect(dom?.querySelector(".cm-filigrane")?.textContent).toBe("l");

        // Text no longer extended by the suggestion: ghost hides.
        pc.setValue(entry, "cat");
        expect(dom?.querySelector(".cm-filigrane")).toBeNull();
    });

    test("ArrowRight at the end of the text accepts the ghost text", () => {
        const pc = document.createElement("prompt-collection") as PromptCollection;
        document.body.append(pc);
        const entry = makeEntry({ label: "a", content: plain("ls") });
        entry.prompt!.filigrane = "ls -l";
        pc.addPrompt(entry);
        const editor = pc.getEditor(entry)!;
        const press = (key: string) =>
            editor.dom
                .querySelector(".cm-content")!
                .dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));

        // Cursor not at the end: plain cursor move, no acceptance.
        editor.setPosition?.(1);
        press("ArrowRight");
        expect(pc.getValue(entry)).toBe("ls");

        // Cursor at the end: the suffix is accepted.
        editor.setPosition?.(2);
        press("ArrowRight");
        expect(pc.getValue(entry)).toBe("ls -l");
        expect(editor.getPosition?.()).toBe(5);
        expect(editor.dom.querySelector(".cm-filigrane")).toBeNull();

        // Ghost gone (fully typed): ArrowRight is an ordinary cursor move.
        editor.setPosition?.(2);
        press("ArrowRight");
        expect(pc.getValue(entry)).toBe("ls -l");
        expect(editor.getPosition?.()).toBe(3);
    });

    test("a frozen editor ignores ArrowRight ghost acceptance", () => {
        const pc = document.createElement("prompt-collection") as PromptCollection;
        document.body.append(pc);
        const entry = makeEntry({
            label: "a",
            content: plain("ls"),
            bindings: { "Ctrl+L": { command: "lock", freeze: true } },
        });
        entry.prompt!.filigrane = "ls -l";
        pc.addPrompt(entry);
        const editor = pc.getEditor(entry)!;
        const press = (init: KeyboardEventInit) =>
            editor.dom
                .querySelector(".cm-content")!
                .dispatchEvent(
                    new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
                );

        // Fire the freezing binding: the prompt dims (frozen class).
        press({ key: "l", ctrlKey: true });
        expect(editor.dom.classList.contains("cm-frozen")).toBe(true);

        // Focus changes rewrite the root's class attribute — the frozen
        // class must survive the blur/refocus cycle.
        const content = editor.dom.querySelector<HTMLElement>(".cm-content")!;
        content.focus();
        expect(editor.dom.classList.contains("cm-frozen")).toBe(true);
        content.blur();
        expect(editor.dom.classList.contains("cm-frozen")).toBe(true);

        // Cursor at the end: ArrowRight no longer accepts the ghost.
        editor.setPosition?.(2);
        press({ key: "ArrowRight" });
        expect(pc.getValue(entry)).toBe("ls");

        // Reconfiguration (prompt_configure) unblocks it: dim gone.
        entry.fire();
        expect(editor.dom.classList.contains("cm-frozen")).toBe(false);
        editor.setPosition?.(2);
        press({ key: "ArrowRight" });
        expect(pc.getValue(entry)).toBe("ls -l");
    });

    test("Escape clears the field and the ghost text", () => {
        const pc = document.createElement("prompt-collection") as PromptCollection;
        document.body.append(pc);
        const entry = makeEntry({ label: "a", content: plain("ls -l") });
        entry.prompt!.filigrane = "ls -la";
        pc.addPrompt(entry);
        const editor = pc.getEditor(entry)!;
        const press = (key: string) =>
            editor.dom
                .querySelector(".cm-content")!
                .dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));

        press("Escape");
        expect(pc.getValue(entry)).toBe("");
        expect(entry.prompt?.content.text).toBe(""); // synced back to the Entry
        expect(editor.getPosition?.()).toBe(0);
        expect(editor.dom.querySelector(".cm-filigrane")).toBeNull();

        // Already empty: a no-op that does not throw.
        press("Escape");
        expect(pc.getValue(entry)).toBe("");
    });
});

describe("prompt-collection — styled values", () => {
    test("setValue with StyledText sets text, colorizes ranges and moves the cursor", () => {
        const pc = make();
        const entry = pc.addPrompt(makeEntry({ label: "a" }));
        const editor = pc.getEditor(entry) as StubEditor;

        pc.setValue(entry, {
            text: "git commit",
            ranges: [
                { start: 0, end: 3, style: "green bold" },
                { start: 4, end: 10, style: "blue" },
            ],
            position: 4,
        });

        // Text goes through the editor.
        expect(pc.getValue(entry)).toBe("git commit");

        // Ranges are resolved into concrete CSS spans via the color grammar.
        // Explicit numeric boundaries are closed (not inclusive).
        expect(editor.spans).toEqual([
            {
                start: 0,
                end: 3,
                css: styleToCss(th.calculateStyle("green bold")),
                inclusiveStart: false,
                inclusiveEnd: false,
            },
            {
                start: 4,
                end: 10,
                css: styleToCss(th.calculateStyle("blue")),
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
        const entry = pc.addPrompt(makeEntry({ label: "a" }));
        const editor = pc.getEditor(entry) as StubEditor;

        pc.setValue(entry, {
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
                css: styleToCss(th.calculateStyle("blue")),
                inclusiveStart: true,
                inclusiveEnd: false,
            },
            {
                start: 3,
                end: 6,
                css: styleToCss(th.calculateStyle("green")),
                inclusiveStart: false,
                inclusiveEnd: true,
            },
        ]);
        // No fully-open range → no base style.
        expect(editor.baseStyle).toBe("");
    });

    test("a fully-open range becomes a whole-editor base style, not a span", () => {
        const pc = make();
        const entry = pc.addPrompt(makeEntry({ label: "a" }));
        const editor = pc.getEditor(entry) as StubEditor;

        pc.setValue(entry, {
            text: "abcdef",
            ranges: [
                { start: null, end: null, style: "red bold" }, // whole editor + future text
                { start: 0, end: 3, style: "blue" }, // a normal span on top
            ],
        });

        expect(editor.baseStyle).toBe(styleToCss(th.calculateStyle("red bold")));
        expect(editor.spans).toEqual([
            {
                start: 0,
                end: 3,
                css: styleToCss(th.calculateStyle("blue")),
                inclusiveStart: false,
                inclusiveEnd: false,
            },
        ]);
    });

    test("a fully-open range styles even an empty prompt (nothing to anchor a span to)", () => {
        const pc = make();
        const entry = pc.addPrompt(makeEntry({ label: "a" }));
        const editor = pc.getEditor(entry) as StubEditor;

        pc.setValue(entry, { text: "", ranges: [{ start: null, end: null, style: "green" }] });

        expect(pc.getValue(entry)).toBe("");
        expect(editor.baseStyle).toBe(styleToCss(th.calculateStyle("green")));
        expect(editor.spans).toEqual([]);
    });

    test("a plain string leaves highlights and position untouched", () => {
        const pc = make();
        const entry = pc.addPrompt(makeEntry({ label: "a" }));
        const editor = pc.getEditor(entry) as StubEditor;
        // Clear whatever the initial content seeded, to isolate setValue's effect.
        editor.spans = undefined;
        editor.position = undefined;

        pc.setValue(entry, "plain");

        expect(pc.getValue(entry)).toBe("plain");
        expect(editor.spans).toBeUndefined();
        expect(editor.position).toBeUndefined();
    });

    test("omitting position does not move the cursor", () => {
        const pc = make();
        const entry = pc.addPrompt(makeEntry({ label: "a" }));
        const editor = pc.getEditor(entry) as StubEditor;
        editor.position = undefined; // clear the seeded position

        pc.setValue(entry, { text: "hello", ranges: [], position: null });

        expect(pc.getValue(entry)).toBe("hello");
        expect(editor.spans).toEqual([]);
        expect(editor.position).toBeUndefined();
    });

    test("ranges with an unparseable accent are skipped, not fatal", () => {
        const pc = make();
        const entry = pc.addPrompt(makeEntry({ label: "a" }));
        const editor = pc.getEditor(entry) as StubEditor;

        pc.setValue(entry, {
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
                css: styleToCss(th.calculateStyle("red")),
                inclusiveStart: false,
                inclusiveEnd: false,
            },
        ]);
    });

    test("initial Prompt content colorizes the editor on add", () => {
        const pc = make();
        const entry = pc.addPrompt(
            makeEntry({
                label: "a",
                content: {
                    text: "git commit",
                    ranges: [{ start: 0, end: 3, style: "green bold" }],
                    position: 3,
                },
            }),
        );
        const editor = pc.getEditor(entry) as StubEditor;
        expect(pc.getValue(entry)).toBe("git commit");
        expect(editor.spans).toEqual([
            {
                start: 0,
                end: 3,
                css: styleToCss(th.calculateStyle("green bold")),
                inclusiveStart: false,
                inclusiveEnd: false,
            },
        ]);
        expect(editor.position).toBe(3);
    });
});

describe("prompt-collection — reordering", () => {
    test("movePrompt reorders the tabs and fires reorder", () => {
        const pc = make();
        const a = pc.addPrompt(makeEntry({ label: "a" }));
        const b = pc.addPrompt(makeEntry({ label: "b" }));
        const c = pc.addPrompt(makeEntry({ label: "c" }));
        const events: Entry[][] = [];
        pc.addEventListener("reorder", (e) => {
            events.push((e as CustomEvent<{ order: Entry[] }>).detail.order);
        });

        pc.movePrompt(c, 0); // c to the front

        expect(pc.prompts).toEqual([c, a, b]);
        expect(tabs(pc).map((t) => t.textContent)).toEqual(["c", "a", "b"]);
        expect(events).toEqual([[c, a, b]]);
    });
});

describe("prompt-collection — focus rotation", () => {
    test("Cmd-Left / Cmd-Right rotate the active prompt cyclically", () => {
        const pc = make();
        const a = pc.addPrompt(makeEntry({ label: "a" }));
        const b = pc.addPrompt(makeEntry({ label: "b" }));
        const c = pc.addPrompt(makeEntry({ label: "c" }));
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
        const a = pc.addPrompt(makeEntry({ label: "a" }));
        (pc.getEditor(a) as StubEditor).navigate?.(1);
        expect(pc.activePrompt).toBe(a);
    });
});

describe("prompt-collection — removing", () => {
    test("removePrompt drops it, destroys its editor and activates the next", () => {
        const pc = make();
        const a = pc.addPrompt(makeEntry({ label: "a", content: plain("aa") }));
        const b = pc.addPrompt(makeEntry({ label: "b" }));
        destroyed.length = 0;

        pc.removePrompt(a); // 'a' was active

        expect(pc.prompts).toEqual([b]);
        expect(tabOf(pc, a)).toBeNull();
        expect(destroyed).toEqual(["aa"]); // editor.destroy() was called
        expect(pc.activePrompt).toBe(b);
        expect(rowOf(pc, b)?.hidden).toBe(false);
    });

    test("removing a prompt detaches its Entry reconfiguration listener", () => {
        const pc = make();
        const a = pc.addPrompt(makeEntry({ label: "a" }));
        expect(a.listeners.length).toBe(1);
        pc.removePrompt(a);
        expect(a.listeners.length).toBe(0);
    });
});

describe("prompt-collection — key bindings", () => {
    const press = (el: Element, init: KeyboardEventInit) =>
        el.dispatchEvent(
            new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
        );

    test("a bound chord fires a command event with command, event, entry, text and position", () => {
        const pc = make();
        const entry = pc.addPrompt(
            makeEntry({ label: "a", bindings: { "Ctrl+L": "clear" }, content: plain("hello") }),
        );
        const editor = pc.getEditor(entry) as StubEditor;
        editor.setPosition?.(2);

        // The listener param is typed as PromptCommandEvent via the event map.
        const events: PromptCommandDetail[] = [];
        pc.addEventListener("command", (e) => {
            events.push(e.detail);
        });

        const ev = new KeyboardEvent("keydown", {
            key: "l",
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
        });
        editor.dom.dispatchEvent(ev);

        expect(events.length).toBe(1);
        expect(events[0].command).toBe("clear");
        expect(events[0].entry).toBe(entry);
        expect(events[0].event).toBe(ev);
        expect(events[0].text).toBe("hello");
        expect(events[0].position).toBe(2);
        // The key is swallowed so the editor doesn't also act on it.
        expect(ev.defaultPrevented).toBe(true);
    });

    test("chord matching is case- and modifier-alias-insensitive", () => {
        const pc = make();
        const entry = pc.addPrompt(
            makeEntry({ label: "a", bindings: { "ctrl+shift+K": "kill" } }),
        );
        const editor = pc.getEditor(entry) as StubEditor;
        const commands: string[] = [];
        pc.addEventListener("command", (e) => commands.push((e as CustomEvent).detail.command));

        press(editor.dom, { key: "K", ctrlKey: true, shiftKey: true });
        expect(commands).toEqual(["kill"]);
    });

    test("an unbound chord does not fire a command event", () => {
        const pc = make();
        const entry = pc.addPrompt(makeEntry({ label: "a", bindings: { "Ctrl+L": "clear" } }));
        const editor = pc.getEditor(entry) as StubEditor;
        let fired = 0;
        pc.addEventListener("command", () => {
            fired++;
        });

        press(editor.dom, { key: "l" }); // no Ctrl
        press(editor.dom, { key: "k", ctrlKey: true }); // different key
        expect(fired).toBe(0);
    });

    test("bindings are read live, so reconfiguring the Entry is heeded", () => {
        const pc = make();
        const entry = pc.addPrompt(makeEntry({ label: "a" }));
        const editor = pc.getEditor(entry) as StubEditor;
        const commands: string[] = [];
        pc.addEventListener("command", (e) => commands.push((e as CustomEvent).detail.command));

        // No binding yet.
        press(editor.dom, { key: "l", ctrlKey: true });
        expect(commands).toEqual([]);

        // Add a binding; it takes effect without re-adding the prompt.
        entry.prompt!.bindings = { "Ctrl+L": "clear" };
        press(editor.dom, { key: "l", ctrlKey: true });
        expect(commands).toEqual(["clear"]);
    });

    test("an object binding fires its command and freezes the editor; reconfiguring unblocks it", () => {
        const pc = make();
        const entry = pc.addPrompt(
            makeEntry({ label: "a", bindings: { "Ctrl+L": { command: "lock", freeze: true } } }),
        );
        const editor = pc.getEditor(entry) as StubEditor;
        const commands: string[] = [];
        pc.addEventListener("command", (e) => commands.push((e as CustomEvent).detail.command));

        press(editor.dom, { key: "l", ctrlKey: true });
        expect(commands).toEqual(["lock"]);
        expect(editor.readOnly).toBe(true);

        // The next prompt_configure (entry.fire() from the driver message)
        // unblocks the editor.
        entry.fire();
        expect(editor.readOnly).toBe(false);

        // A non-freezing object binding fires without freezing.
        entry.prompt!.bindings = { "Ctrl+J": { command: "jump" } };
        press(editor.dom, { key: "j", ctrlKey: true });
        expect(commands).toEqual(["lock", "jump"]);
        expect(editor.readOnly).toBe(false);
    });
});

describe("prompt-collection — previous/next virtual chords", () => {
    const press = (el: Element, init: KeyboardEventInit) => {
        const ev = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
        el.dispatchEvent(ev);
        return ev;
    };

    test("ArrowUp on the first line fires the 'previous' binding; elsewhere it falls through", () => {
        const pc = make();
        const entry = pc.addPrompt(
            makeEntry({
                label: "a",
                content: plain("one\ntwo\nthree"),
                bindings: { Previous: "prev-history", Next: "next-history" },
            }),
        );
        const editor = pc.getEditor(entry) as StubEditor;
        const commands: string[] = [];
        pc.addEventListener("command", (e) => commands.push((e as CustomEvent).detail.command));

        // Cursor on the first line: Up fires "previous" and is swallowed.
        editor.setPosition?.(1);
        const up = press(editor.dom, { key: "ArrowUp" });
        expect(commands).toEqual(["prev-history"]);
        expect(up.defaultPrevented).toBe(true);

        // Cursor on a middle line: no command, the key reaches the editor.
        commands.length = 0;
        editor.setPosition?.(5);
        const upMid = press(editor.dom, { key: "ArrowUp" });
        expect(commands).toEqual([]);
        expect(upMid.defaultPrevented).toBe(false);
    });

    test("ArrowDown on the last line fires the 'next' binding; elsewhere it falls through", () => {
        const pc = make();
        const entry = pc.addPrompt(
            makeEntry({
                label: "a",
                content: plain("one\ntwo\nthree"),
                bindings: { Previous: "prev-history", Next: "next-history" },
            }),
        );
        const editor = pc.getEditor(entry) as StubEditor;
        const commands: string[] = [];
        pc.addEventListener("command", (e) => commands.push((e as CustomEvent).detail.command));

        // Cursor on the last line: Down fires "next".
        editor.setPosition?.(10);
        const down = press(editor.dom, { key: "ArrowDown" });
        expect(commands).toEqual(["next-history"]);
        expect(down.defaultPrevented).toBe(true);

        // Cursor on the first line: no command, ordinary cursor motion.
        commands.length = 0;
        editor.setPosition?.(1);
        const downTop = press(editor.dom, { key: "ArrowDown" });
        expect(commands).toEqual([]);
        expect(downTop.defaultPrevented).toBe(false);
    });

    test("a single-line prompt is both first and last line", () => {
        const pc = make();
        const entry = pc.addPrompt(
            makeEntry({
                label: "a",
                content: plain("ls"),
                bindings: { Previous: "prev", Next: "next" },
            }),
        );
        const editor = pc.getEditor(entry) as StubEditor;
        const commands: string[] = [];
        pc.addEventListener("command", (e) => commands.push((e as CustomEvent).detail.command));

        press(editor.dom, { key: "ArrowUp" });
        press(editor.dom, { key: "ArrowDown" });
        expect(commands).toEqual(["prev", "next"]);
    });

    test("without a previous/next binding the arrows keep their default behavior", () => {
        const pc = make();
        const entry = pc.addPrompt(makeEntry({ label: "a", content: plain("one\ntwo") }));
        const editor = pc.getEditor(entry) as StubEditor;
        let fired = 0;
        pc.addEventListener("command", () => fired++);

        editor.setPosition?.(0);
        const up = press(editor.dom, { key: "ArrowUp" });
        const down = press(editor.dom, { key: "ArrowDown" });
        expect(fired).toBe(0);
        expect(up.defaultPrevented).toBe(false);
        expect(down.defaultPrevented).toBe(false);
    });

    test("modified arrows never trigger the virtual chords", () => {
        const pc = make();
        const entry = pc.addPrompt(
            makeEntry({ label: "a", content: plain("ls"), bindings: { Previous: "prev" } }),
        );
        const editor = pc.getEditor(entry) as StubEditor;
        let fired = 0;
        pc.addEventListener("command", () => fired++);

        editor.setPosition?.(0);
        press(editor.dom, { key: "ArrowUp", shiftKey: true });
        press(editor.dom, { key: "ArrowUp", ctrlKey: true });
        expect(fired).toBe(0);
    });

    test("an explicit ArrowUp binding wins over the previous binding on the first line", () => {
        const pc = make();
        const entry = pc.addPrompt(
            makeEntry({
                label: "a",
                content: plain("ls"),
                bindings: { ArrowUp: "top", Previous: "prev" },
            }),
        );
        const editor = pc.getEditor(entry) as StubEditor;
        const commands: string[] = [];
        pc.addEventListener("command", (e) => commands.push((e as CustomEvent).detail.command));

        editor.setPosition?.(0);
        press(editor.dom, { key: "ArrowUp" });
        expect(commands).toEqual(["top"]);
    });

    test("with the real editor, ArrowUp on the first line fires previous instead of moving the cursor", () => {
        const pc = document.createElement("prompt-collection") as PromptCollection;
        document.body.append(pc);
        const entry = makeEntry({
            label: "a",
            content: plain("one\ntwo"),
            bindings: { Previous: "prev-history" },
        });
        pc.addPrompt(entry);
        const editor = pc.getEditor(entry)!;
        const commands: string[] = [];
        pc.addEventListener("command", (e) => commands.push((e as CustomEvent).detail.command));
        const press = (key: string) =>
            editor.dom
                .querySelector(".cm-content")!
                .dispatchEvent(
                    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
                );

        // Cursor on the second line: plain cursor motion, no command.
        editor.setPosition?.(5);
        press("ArrowUp");
        expect(commands).toEqual([]);
        expect(editor.getPosition?.()).toBe(0);

        // Cursor back on the first line: the command fires, cursor untouched.
        press("ArrowUp");
        expect(commands).toEqual(["prev-history"]);
        expect(editor.getPosition?.()).toBe(0);
    });
});
