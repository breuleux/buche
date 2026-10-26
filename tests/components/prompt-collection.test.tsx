// @vitest-environment happy-dom

import { afterEach, describe, expect, test } from "vitest";
import { styleToCss, defaultTheme as th } from "../../src/color.ts";
import type {
    EditorFactory,
    PromptCollection,
    PromptCommandDetail,
    PromptEditor,
    PromptTextChangeDetail,
    StyleSpan,
} from "../../src/components/prompt-collection.tsx";
import "../../src/components/prompt-collection.tsx";
import type { PromptBindings, PromptCell } from "../../src/cells/prompt.ts";
import { Entry } from "../../src/entry.ts";
import type {
    Action,
    InteractiveStructuredText,
    Selection,
    StructuredText,
} from "../../src/types.ts";
import { plainText } from "../../src/utils.ts";

afterEach(() => {
    document.body.replaceChildren();
});

// A lightweight stand-in for the CodeMirror editor so tests don't construct a
// real EditorView (which needs layout). Records destruction and change calls.
const destroyed: string[] = [];
// The editor handle, plus a test hook to fire the navigation callback that the
// real CodeMirror editor binds to Cmd/Ctrl-Left/Right.
type StubEditor = ReturnType<EditorFactory> & {
    /** Last spans/base-style/selection handed to the editor, for assertions. */
    spans?: StyleSpan[];
    baseStyle?: string;
    selection?: Selection;
    filigrane?: string | null;
    readOnly?: boolean;
};

function stubFactory(): EditorFactory {
    return ({ doc, onChange }) => {
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
            setSelection: (selection) => {
                editor.selection = selection;
            },
            setFiligrane: (filigrane) => {
                editor.filigrane = filigrane;
            },
            setEditability: (editability) => {
                editor.readOnly = editability !== "editable";
            },
            getSelection: () => editor.selection ?? { start: value.length, end: value.length },
            focus: () => {},
            destroy: () => {
                destroyed.push(value);
                dom.remove();
            },
        };
        return editor;
    };
}

// The editors the collections made, by their element (see editorOf).
const editors = new WeakMap<Element, PromptEditor>();

/** Record the editors `pc` makes, so tests can reach them (see editorOf). */
function track(pc: PromptCollection): PromptCollection {
    const factory = pc.editorFactory;
    pc.editorFactory = (options) => {
        const editor = factory(options);
        editors.set(editor.dom, editor);
        return editor;
    };
    return pc;
}

/** The editor of `entry`'s prompt in `pc` (made while `pc` was tracked). */
function editorOf(pc: PromptCollection, entry: Entry): PromptEditor | null {
    const dom = pc
        .promptElement(entry)
        ?.querySelector(".prompt-collection-editor")?.firstElementChild;
    return (dom && editors.get(dom)) ?? null;
}

function make(): PromptCollection {
    const pc = document.createElement("prompt-collection") as PromptCollection;
    pc.editorFactory = stubFactory();
    track(pc);
    document.body.append(pc);
    return pc;
}

const plain = (text: string): StructuredText => ({ parts: [{ text }] });

/** An action's name: its command line, or its built-in's name. */
const actionName = (action: Action): string =>
    typeof action === "string" ? action : "builtin" in action ? action.builtin : action.command;

// Move the cursor (an empty selection) to an offset.
const setCursor = (editor: PromptEditor, offset: number) =>
    editor.setSelection?.({ start: offset, end: offset });

/** An entry's cell, as the prompt it is. */
const promptCell = (entry: Entry) => entry.cell as PromptCell;

// Build a prompt Entry: label + accent, marker + content, all on its cell.
function makeEntry(
    opts: {
        label?: string;
        color?: string;
        marker?: StructuredText;
        content?: InteractiveStructuredText;
        bindings?: PromptBindings;
    } = {},
): Entry {
    const entry = new Entry({});
    if (opts.label != null) {
        entry.cell.label = { parts: [{ text: opts.label }] };
    }
    if (opts.color != null) {
        entry.cell.color = opts.color;
    }
    entry.replaceCell("prompt");
    promptCell(entry).configurePrompt({
        input: {
            context: opts.marker ?? { parts: [] },
            content: opts.content ?? { parts: [] },
        },
        bindings: opts.bindings,
    });
    return entry;
}

const rowOf = (pc: PromptCollection, entry: Entry) => pc.promptElement(entry);

describe("prompt-collection — structure", () => {
    test("builds a prompts container", () => {
        const pc = make();
        expect(pc.querySelector(".prompt-collection-prompts")).not.toBeNull();
    });
});

describe("prompt-collection — adding prompts", () => {
    test("creates an editor and a leading marker; first is active", () => {
        const pc = make();
        const entry = pc.addPrompt(
            makeEntry({
                label: "sh",
                color: "green",
                marker: { parts: [{ text: "$", style: "green bold" }] },
                content: plain("ls"),
            }),
        );

        // Marker renders the Prompt's `prompt` StructuredText, to the left; the editor
        // holds the Prompt's `content` text.
        const r = rowOf(pc, entry)!;
        const marker = r.querySelector(".prompt-collection-marker")!;
        expect(marker.textContent).toBe("$");
        expect(marker.querySelector(".styled-text")).not.toBeNull();
        expect(r.querySelector(".prompt-collection-editor .stub-editor")?.textContent).toBe("ls");

        // The row wears its cell's accent, resolved through the color grammar.
        expect(r.style.getPropertyValue("--prompt-accent")).toBe(th.calculateColor("green"));

        // First prompt is active and shown.
        expect(pc.activePrompt).toBe(entry);
        expect(r.hidden).toBe(false);
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
    test("showPrompt shows its prompt and hides the others", () => {
        const pc = make();
        const a = pc.addPrompt(makeEntry({ label: "a" }));
        const b = pc.addPrompt(makeEntry({ label: "b" }));

        pc.showPrompt(b);

        expect(pc.activePrompt).toBe(b);
        expect(rowOf(pc, a)?.hidden).toBe(true);
        expect(rowOf(pc, b)?.hidden).toBe(false);
    });
});

describe("prompt-collection — reconfiguration", () => {
    test("firing the Entry re-reads the accent and marker", () => {
        const pc = make();
        const entry = pc.addPrompt(makeEntry({ label: "a", color: "blue", marker: plain("$") }));

        entry.cell.color = "red";
        promptCell(entry).input.context = { parts: [{ text: ">" }] };
        entry.fire();

        expect(rowOf(pc, entry)?.style.getPropertyValue("--prompt-accent")).toBe(
            th.calculateColor("red"),
        );
        expect(rowOf(pc, entry)?.querySelector(".prompt-collection-marker")?.textContent).toBe(
            ">",
        );
    });

    test("firing the Entry resets the editor text and selection from content", () => {
        const pc = make();
        const entry = pc.addPrompt(makeEntry({ label: "a", content: plain("first") }));
        const editor = editorOf(pc, entry) as StubEditor;
        expect(editorOf(pc, entry)?.getValue()).toBe("first");

        // Mutate the Prompt's content and fire: the editor resets to it.
        promptCell(entry).input.content.parts = [{ text: "reset" }];
        promptCell(entry).input.content.selection = { start: 2, end: 2 };
        entry.fire();

        expect(editorOf(pc, entry)?.getValue()).toBe("reset");
        expect(editor.selection).toEqual({ start: 2, end: 2 });
    });

    test("resetting from content does not feed back into content", () => {
        const pc = make();
        const entry = pc.addPrompt(makeEntry({ label: "a", content: plain("hi") }));
        promptCell(entry).input.content.parts = [{ text: "reset" }];
        promptCell(entry).input.content.selection = { start: 1, end: 1 };
        entry.fire();
        // The reset is applied to the editor but the stored content is preserved.
        expect(plainText(promptCell(entry).input.content)).toBe("reset");
        expect(promptCell(entry).input.content.selection).toEqual({
            start: 1,
            end: 1,
        });
    });

    test("a prompt whose echo is done or error is removed on reconfiguration", () => {
        const pc = make();
        const a = pc.addPrompt(makeEntry({ label: "a" }));
        const b = pc.addPrompt(makeEntry({ label: "b" }));
        destroyed.length = 0;

        a.cell.status = { status: "done" };
        a.fire();
        expect(pc.prompts).toEqual([b]);
        expect(rowOf(pc, a)).toBeNull();
        expect(destroyed).toEqual([""]);
        expect(pc.activePrompt).toBe(b); // 'a' was active; activation moved on

        b.cell.status = { status: "error" };
        b.fire();
        expect(pc.prompts).toEqual([]);
        expect(pc.activePrompt).toBeNull();
    });

    test("a running echo reconfigures normally", () => {
        const pc = make();
        const entry = pc.addPrompt(makeEntry({ label: "a", content: plain("keep") }));
        entry.cell.status = { status: "running" };
        entry.fire();
        expect(pc.prompts).toEqual([entry]);
    });
});

describe("prompt-collection — editor values", () => {
    test("the editor is seeded from the Prompt content; edits flow back to it", () => {
        const pc = make();
        const entry = pc.addPrompt(makeEntry({ label: "a", content: plain("one") }));
        expect(editorOf(pc, entry)?.getValue()).toBe("one");

        pc.setValue(entry, "two");
        expect(editorOf(pc, entry)?.getValue()).toBe("two");
        // Edits are synced back into the Entry's Prompt content.
        expect(plainText(promptCell(entry).input.content)).toBe("two");
    });

    test("editing updates the Entry's content text and selection", () => {
        const pc = make();
        const entry = pc.addPrompt(makeEntry({ label: "a", content: plain("") }));
        const editor = editorOf(pc, entry) as StubEditor;

        setCursor(editor, 3); // move the cursor
        editor.setValue("hello"); // simulate a user edit

        expect(plainText(promptCell(entry).input.content)).toBe("hello");
        expect(promptCell(entry).input.content.selection).toEqual({
            start: 3,
            end: 3,
        });
    });

    test("editing fires textchange with entry, text and selection", () => {
        const pc = make();
        const entry = pc.addPrompt(makeEntry({ label: "a", content: plain("") }));
        const editor = editorOf(pc, entry) as StubEditor;

        const events: PromptTextChangeDetail[] = [];
        pc.addEventListener("textchange", (e) => {
            events.push((e as CustomEvent<PromptTextChangeDetail>).detail);
        });

        setCursor(editor, 2);
        editor.setValue("hello");

        expect(events).toHaveLength(1);
        expect(events[0].entry).toBe(entry);
        expect(events[0].text).toBe("hello");
        expect(events[0].selection).toEqual({ start: 2, end: 2 });
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
        expect(editorOf(pc, entry)?.getValue()).toBe("pushed");
    });

    test("filigrane is handed to the editor on add and refreshed on reconfigure", () => {
        const pc = make();
        const entry = makeEntry({ label: "a", content: plain("ls") });
        promptCell(entry).input.content.filigrane = "ls -l";
        pc.addPrompt(entry);
        const editor = editorOf(pc, entry) as StubEditor;
        expect(editor.filigrane).toBe("ls -l");

        promptCell(entry).input.content.filigrane = undefined;
        entry.fire();
        expect(editor.filigrane).toBeNull();
    });
});

describe("prompt-collection — ghost text (real CodeMirror)", () => {
    test("the filigrane suffix past the text renders as ghost text", () => {
        const pc = track(document.createElement("prompt-collection") as PromptCollection);
        document.body.append(pc);
        const entry = makeEntry({ label: "a", content: plain("ls") });
        promptCell(entry).input.content.filigrane = "ls -l";
        pc.addPrompt(entry);
        const dom = editorOf(pc, entry)?.dom;
        expect(dom?.querySelector(".cm-filigrane")?.textContent).toBe(" -l");

        // Typing to extend the text shrinks the ghost accordingly.
        pc.setValue(entry, "ls -");
        expect(dom?.querySelector(".cm-filigrane")?.textContent).toBe("l");

        // Text no longer extended by the suggestion: ghost hides.
        pc.setValue(entry, "cat");
        expect(dom?.querySelector(".cm-filigrane")).toBeNull();
    });

    test("ArrowRight at the end of the text accepts the ghost text", () => {
        const pc = track(document.createElement("prompt-collection") as PromptCollection);
        document.body.append(pc);
        const entry = makeEntry({ label: "a", content: plain("ls") });
        promptCell(entry).input.content.filigrane = "ls -l";
        pc.addPrompt(entry);
        const editor = editorOf(pc, entry)!;
        const press = (key: string) =>
            editor.dom
                .querySelector(".cm-content")!
                .dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));

        // Cursor not at the end: plain cursor move, no acceptance.
        setCursor(editor, 1);
        press("ArrowRight");
        expect(editorOf(pc, entry)?.getValue()).toBe("ls");

        // Cursor at the end: the suffix is accepted.
        setCursor(editor, 2);
        press("ArrowRight");
        expect(editorOf(pc, entry)?.getValue()).toBe("ls -l");
        expect(editor.getSelection?.()).toEqual({ start: 5, end: 5 });
        expect(editor.dom.querySelector(".cm-filigrane")).toBeNull();

        // Ghost gone (fully typed): ArrowRight is an ordinary cursor move.
        setCursor(editor, 2);
        press("ArrowRight");
        expect(editorOf(pc, entry)?.getValue()).toBe("ls -l");
        expect(editor.getSelection?.()).toEqual({ start: 3, end: 3 });
    });

    test("a frozen editor ignores ArrowRight ghost acceptance", () => {
        const pc = track(document.createElement("prompt-collection") as PromptCollection);
        document.body.append(pc);
        const entry = makeEntry({
            label: "a",
            content: plain("ls"),
            bindings: { "Ctrl+L": { builtin: "lock", freeze: true } },
        });
        promptCell(entry).input.content.filigrane = "ls -l";
        pc.addPrompt(entry);
        const editor = editorOf(pc, entry)!;
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
        setCursor(editor, 2);
        press({ key: "ArrowRight" });
        expect(editorOf(pc, entry)?.getValue()).toBe("ls");

        // Reconfiguration (prompt_configure) unblocks it: dim gone once fresh
        // content arrives (no editability on it: editable is the default).
        promptCell(entry).configurePrompt({
            input: {
                content: {
                    parts: [{ text: "ls" }],
                    selection: { start: 2, end: 2 },
                    filigrane: "ls -l",
                },
            },
        });
        entry.fire();
        expect(editor.dom.classList.contains("cm-frozen")).toBe(false);
        setCursor(editor, 2);
        press({ key: "ArrowRight" });
        expect(editorOf(pc, entry)?.getValue()).toBe("ls -l");
    });

    test("editability follows the content: readonly renders, freeze overrides, reset clears", () => {
        const pc = track(document.createElement("prompt-collection") as PromptCollection);
        document.body.append(pc);
        const entry = makeEntry({
            label: "a",
            content: {
                parts: [{ text: "ls" }],
                selection: { start: 2, end: 2 },
                editability: "readonly",
            },
            bindings: { "Ctrl+L": { builtin: "lock", freeze: true } },
        });
        pc.addPrompt(entry);
        const editor = editorOf(pc, entry)!;
        expect(editor.dom.classList.contains("cm-readonly")).toBe(true);

        // The freezing binding overrides the configured state (temporary look).
        editor.dom.querySelector(".cm-content")!.dispatchEvent(
            new KeyboardEvent("keydown", {
                key: "l",
                ctrlKey: true,
                bubbles: true,
                cancelable: true,
            }),
        );
        expect(promptCell(entry).input.content.editability).toBe("frozen");
        expect(editor.dom.classList.contains("cm-frozen")).toBe(true);
        expect(editor.dom.classList.contains("cm-readonly")).toBe(false);

        // A content reset without an editability restores the prompt default.
        promptCell(entry).configurePrompt({
            input: { content: { parts: [{ text: "ls" }], selection: { start: 2, end: 2 } } },
        });
        entry.fire();
        expect(promptCell(entry).input.content.editability).toBeUndefined();
        expect(editor.dom.classList.contains("cm-frozen")).toBe(false);
        expect(editor.dom.classList.contains("cm-readonly")).toBe(false);
    });

    test("Escape clears the field and the ghost text", () => {
        const pc = track(document.createElement("prompt-collection") as PromptCollection);
        document.body.append(pc);
        const entry = makeEntry({ label: "a", content: plain("ls -l") });
        promptCell(entry).input.content.filigrane = "ls -la";
        pc.addPrompt(entry);
        const editor = editorOf(pc, entry)!;
        const press = (key: string) =>
            editor.dom
                .querySelector(".cm-content")!
                .dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));

        press("Escape");
        expect(editorOf(pc, entry)?.getValue()).toBe("");
        expect(plainText(promptCell(entry).input.content)).toBe(""); // synced back to the Entry
        expect(promptCell(entry).input.content.filigrane).toBeUndefined(); // dropped as stale
        expect(editor.getSelection?.()).toEqual({ start: 0, end: 0 });
        expect(editor.dom.querySelector(".cm-filigrane")).toBeNull();

        // Already empty: a no-op that does not throw.
        press("Escape");
        expect(editorOf(pc, entry)?.getValue()).toBe("");
    });

    test("a configure replacing the content drops the ghost (the submit reset)", () => {
        const pc = track(document.createElement("prompt-collection") as PromptCollection);
        document.body.append(pc);
        const entry = makeEntry({ label: "a", content: plain("ls") });
        promptCell(entry).input.content.filigrane = "ls -l";
        pc.addPrompt(entry);
        const editor = editorOf(pc, entry)!;
        expect(editor.dom.querySelector(".cm-filigrane")).not.toBeNull();

        // What the driver sends on submit (see coquille's command$submit):
        // the content is replaced whole, so the ghost it doesn't carry goes
        // away — and stays away through later updates.
        promptCell(entry).configurePrompt({
            input: { content: { parts: [], selection: { start: 0, end: 0 } } },
        });
        entry.fire();
        expect(editor.dom.querySelector(".cm-filigrane")).toBeNull();
        entry.fire();
        expect(editor.dom.querySelector(".cm-filigrane")).toBeNull();
    });

    test("a configure without filigrane leaves the ghost alone", () => {
        const pc = track(document.createElement("prompt-collection") as PromptCollection);
        document.body.append(pc);
        const entry = makeEntry({ label: "a", content: plain("ls") });
        promptCell(entry).input.content.filigrane = "ls -l";
        pc.addPrompt(entry);
        const editor = editorOf(pc, entry)!;
        promptCell(entry).configurePrompt({ bindings: {} });
        entry.fire();
        expect(editor.dom.querySelector(".cm-filigrane")?.textContent).toBe(" -l");
    });
});

describe("prompt-collection — styled values", () => {
    test("setValue with StructuredText sets text, colorizes parts and moves the cursor", () => {
        const pc = make();
        const entry = pc.addPrompt(makeEntry({ label: "a" }));
        const editor = editorOf(pc, entry) as StubEditor;

        pc.setValue(entry, {
            parts: [
                { text: "git", style: "green bold" },
                { text: " " },
                { text: "commit", style: "blue" },
                { text: "!" },
            ],
            selection: { start: 4, end: 4 },
        });

        // Text goes through the editor.
        expect(editorOf(pc, entry)?.getValue()).toBe("git commit!");

        // Styled parts are resolved into concrete CSS spans via the color
        // grammar. Inner boundaries are closed (not inclusive).
        expect(editor.spans).toEqual([
            {
                start: 0,
                end: 3,
                css: styleToCss(th.calculateStyle("green bold")),
                inclusiveStart: true,
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

        // The selection is forwarded.
        expect(editor.selection).toEqual({ start: 4, end: 4 });
    });

    test("the first part's start and the last part's end are open", () => {
        const pc = make();
        const entry = pc.addPrompt(makeEntry({ label: "a" }));
        const editor = editorOf(pc, entry) as StubEditor;

        pc.setValue(entry, {
            parts: [
                { text: "abc", style: "blue" },
                { text: "def", style: "green" },
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
        // More than one part → no base style.
        expect(editor.baseStyle).toBe("");
    });

    test("a single part becomes a whole-editor base style, not a span", () => {
        const pc = make();
        const entry = pc.addPrompt(makeEntry({ label: "a" }));
        const editor = editorOf(pc, entry) as StubEditor;

        pc.setValue(entry, { parts: [{ text: "abcdef", style: "red bold" }] });

        expect(editor.baseStyle).toBe(styleToCss(th.calculateStyle("red bold")));
        expect(editor.spans).toEqual([]);
    });

    test("a single part styles even an empty prompt (nothing to anchor a span to)", () => {
        const pc = make();
        const entry = pc.addPrompt(makeEntry({ label: "a" }));
        const editor = editorOf(pc, entry) as StubEditor;

        pc.setValue(entry, { parts: [{ text: "", style: "green" }] });

        expect(editorOf(pc, entry)?.getValue()).toBe("");
        expect(editor.baseStyle).toBe(styleToCss(th.calculateStyle("green")));
        expect(editor.spans).toEqual([]);
    });

    test("a plain string leaves highlights and selection untouched", () => {
        const pc = make();
        const entry = pc.addPrompt(makeEntry({ label: "a" }));
        const editor = editorOf(pc, entry) as StubEditor;
        // Clear whatever the initial content seeded, to isolate setValue's effect.
        editor.spans = undefined;
        editor.selection = undefined;

        pc.setValue(entry, "plain");

        expect(editorOf(pc, entry)?.getValue()).toBe("plain");
        expect(editor.spans).toBeUndefined();
        expect(editor.selection).toBeUndefined();
    });

    test("omitting the selection does not move the cursor", () => {
        const pc = make();
        const entry = pc.addPrompt(makeEntry({ label: "a" }));
        const editor = editorOf(pc, entry) as StubEditor;
        editor.selection = undefined; // clear the seeded selection

        pc.setValue(entry, { parts: [{ text: "hello" }], selection: null });

        expect(editorOf(pc, entry)?.getValue()).toBe("hello");
        expect(editor.spans).toEqual([]);
        expect(editor.selection).toBeUndefined();
    });

    test("spacers are ignored in the editor", () => {
        const pc = make();
        const entry = pc.addPrompt(makeEntry({ label: "a" }));
        const editor = editorOf(pc, entry) as StubEditor;

        // One text part, between spacers: still the whole-editor base style.
        pc.setValue(entry, {
            parts: [{ spacer: "grow" }, { text: "ls", style: "red" }, { spacer: "grow" }],
        });
        expect(editorOf(pc, entry)?.getValue()).toBe("ls");
        expect(editor.baseStyle).toBe(styleToCss(th.calculateStyle("red")));
        expect(editor.spans).toEqual([]);
    });

    test("parts with an unparseable accent are skipped, not fatal", () => {
        const pc = make();
        const entry = pc.addPrompt(makeEntry({ label: "a" }));
        const editor = editorOf(pc, entry) as StubEditor;

        pc.setValue(entry, {
            parts: [
                { text: "ab", style: "chartreuse" }, // unknown color → skipped
                { text: "cd", style: "red" },
                { text: "ef" },
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
                    parts: [{ text: "git", style: "green bold" }, { text: " commit" }],
                    selection: { start: 3, end: 3 },
                },
            }),
        );
        const editor = editorOf(pc, entry) as StubEditor;
        expect(editorOf(pc, entry)?.getValue()).toBe("git commit");
        expect(editor.spans).toEqual([
            {
                start: 0,
                end: 3,
                css: styleToCss(th.calculateStyle("green bold")),
                inclusiveStart: true,
                inclusiveEnd: false,
            },
        ]);
        expect(editor.selection).toEqual({ start: 3, end: 3 });
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
        expect(rowOf(pc, a)).toBeNull();
        expect(destroyed).toEqual(["aa"]); // editor.destroy() was called
        expect(pc.activePrompt).toBe(b);
        expect(rowOf(pc, b)?.hidden).toBe(false);
    });

    test("removing the active prompt reverts to the previously active one", () => {
        const pc = make();
        const a = pc.addPrompt(makeEntry({ label: "a" }));
        const b = pc.addPrompt(makeEntry({ label: "b" }));
        const c = pc.addPrompt(makeEntry({ label: "c" }));
        pc.showPrompt(c);
        pc.showPrompt(b);

        pc.removePrompt(b);
        expect(pc.activePrompt).toBe(c);
        expect(rowOf(pc, c)?.hidden).toBe(false);

        pc.removePrompt(c);
        expect(pc.activePrompt).toBe(a);
    });

    test("removing an inactive prompt keeps the active one", () => {
        const pc = make();
        const a = pc.addPrompt(makeEntry({ label: "a" }));
        const b = pc.addPrompt(makeEntry({ label: "b" }));
        pc.showPrompt(b);
        pc.removePrompt(a);
        expect(pc.activePrompt).toBe(b);
    });

    test("removing a prompt detaches its Entry reconfiguration listener", () => {
        const pc = make();
        const a = pc.addPrompt(makeEntry({ label: "a" }));
        expect(a.listeners.length).toBe(1);
        pc.removePrompt(a);
        expect(a.listeners.length).toBe(0);
    });
});

describe("prompt-collection — context actions", () => {
    test("clicking a context part with an action fires a command event, like a binding", () => {
        const pc = make();
        const entry = pc.addPrompt(
            makeEntry({
                label: "a",
                content: plain("hello"),
                marker: {
                    parts: [
                        { text: "host " },
                        { text: "~/src", action: "ls" },
                        { spacer: "grow" },
                        { text: "12:00", action: { builtin: "lock", freeze: true } },
                    ],
                },
            }),
        );
        const editor = editorOf(pc, entry) as StubEditor;
        setCursor(editor, 3);
        const events: PromptCommandDetail[] = [];
        pc.addEventListener("command", (e) => {
            events.push(e.detail);
        });

        const marker = rowOf(pc, entry)!.querySelector(".prompt-collection-marker")!;
        const [path, time] = marker.querySelectorAll<HTMLElement>(".styled-text-action");
        expect(path.textContent).toBe("~/src");
        path.click();
        expect(events.length).toBe(1);
        expect(events[0]).toMatchObject({
            action: "ls",
            entry,
            text: "hello",
            selection: { start: 3, end: 3 },
        });
        expect(events[0].event).toBeInstanceOf(MouseEvent);
        expect(editor.readOnly ?? false).toBe(false);

        // A freezing action freezes the prompt, as its binding would.
        time.click();
        expect(events[1].action).toEqual({ builtin: "lock", freeze: true });
        expect(promptCell(entry).input.content.editability).toBe("frozen");
    });

    test("an action survives a reconfiguration of the context", () => {
        const pc = make();
        const entry = pc.addPrompt(makeEntry({ label: "a", marker: plain("$") }));
        const commands: string[] = [];
        pc.addEventListener("command", (e) => commands.push(actionName(e.detail.action)));
        promptCell(entry).input.context = { parts: [{ text: "~", action: "home" }] };
        entry.fire();
        rowOf(pc, entry)!.querySelector<HTMLElement>(".styled-text-action")!.click();
        expect(commands).toEqual(["home"]);
    });
});

describe("prompt-collection — key bindings", () => {
    const press = (el: Element, init: KeyboardEventInit) =>
        el.dispatchEvent(
            new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
        );

    test("a bound chord fires a command event with command, event, entry, text and selection", () => {
        const pc = make();
        const entry = pc.addPrompt(
            makeEntry({ label: "a", bindings: { "Ctrl+L": "clear" }, content: plain("hello") }),
        );
        const editor = editorOf(pc, entry) as StubEditor;
        setCursor(editor, 2);

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
        expect(events[0].action).toBe("clear");
        expect(events[0].entry).toBe(entry);
        expect(events[0].event).toBe(ev);
        expect(events[0].text).toBe("hello");
        expect(events[0].selection).toEqual({ start: 2, end: 2 });
        // The key is swallowed so the editor doesn't also act on it.
        expect(ev.defaultPrevented).toBe(true);
    });

    test("chord matching is case- and modifier-alias-insensitive", () => {
        const pc = make();
        const entry = pc.addPrompt(
            makeEntry({ label: "a", bindings: { "ctrl+shift+K": "kill" } }),
        );
        const editor = editorOf(pc, entry) as StubEditor;
        const commands: string[] = [];
        pc.addEventListener("command", (e) =>
            commands.push(actionName((e as CustomEvent).detail.action)),
        );

        press(editor.dom, { key: "K", ctrlKey: true, shiftKey: true });
        expect(commands).toEqual(["kill"]);
    });

    test("an unbound chord does not fire a command event", () => {
        const pc = make();
        const entry = pc.addPrompt(makeEntry({ label: "a", bindings: { "Ctrl+L": "clear" } }));
        const editor = editorOf(pc, entry) as StubEditor;
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
        const editor = editorOf(pc, entry) as StubEditor;
        const commands: string[] = [];
        pc.addEventListener("command", (e) =>
            commands.push(actionName((e as CustomEvent).detail.action)),
        );

        // No binding yet.
        press(editor.dom, { key: "l", ctrlKey: true });
        expect(commands).toEqual([]);

        // Add a binding; it takes effect without re-adding the prompt.
        promptCell(entry).bindings = { "Ctrl+L": "clear" };
        press(editor.dom, { key: "l", ctrlKey: true });
        expect(commands).toEqual(["clear"]);
    });

    test("an object binding fires its command and freezes the editor; reconfiguring unblocks it", () => {
        const pc = make();
        const entry = pc.addPrompt(
            makeEntry({ label: "a", bindings: { "Ctrl+L": { builtin: "lock", freeze: true } } }),
        );
        const editor = editorOf(pc, entry) as StubEditor;
        const commands: string[] = [];
        pc.addEventListener("command", (e) =>
            commands.push(actionName((e as CustomEvent).detail.action)),
        );

        press(editor.dom, { key: "l", ctrlKey: true });
        expect(commands).toEqual(["lock"]);
        expect(editor.readOnly).toBe(true);

        // The next prompt_configure (entry.fire() from the driver message)
        // unblocks the editor when it brings fresh content: the whole-content
        // replacement carries no editability, and editable is the default.
        promptCell(entry).configurePrompt({
            input: { content: { parts: [], selection: { start: 0, end: 0 } } },
        });
        entry.fire();
        expect(editor.readOnly).toBe(false);

        // A non-freezing object binding fires without freezing.
        promptCell(entry).bindings = { "Ctrl+J": { command: "jump" } };
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
        const editor = editorOf(pc, entry) as StubEditor;
        const commands: string[] = [];
        pc.addEventListener("command", (e) =>
            commands.push(actionName((e as CustomEvent).detail.action)),
        );

        // Cursor on the first line: Up fires "previous" and is swallowed.
        setCursor(editor, 1);
        const up = press(editor.dom, { key: "ArrowUp" });
        expect(commands).toEqual(["prev-history"]);
        expect(up.defaultPrevented).toBe(true);

        // Cursor on a middle line: no command, the key reaches the editor.
        commands.length = 0;
        setCursor(editor, 5);
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
        const editor = editorOf(pc, entry) as StubEditor;
        const commands: string[] = [];
        pc.addEventListener("command", (e) =>
            commands.push(actionName((e as CustomEvent).detail.action)),
        );

        // Cursor on the last line: Down fires "next".
        setCursor(editor, 10);
        const down = press(editor.dom, { key: "ArrowDown" });
        expect(commands).toEqual(["next-history"]);
        expect(down.defaultPrevented).toBe(true);

        // Cursor on the first line: no command, ordinary cursor motion.
        commands.length = 0;
        setCursor(editor, 1);
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
        const editor = editorOf(pc, entry) as StubEditor;
        const commands: string[] = [];
        pc.addEventListener("command", (e) =>
            commands.push(actionName((e as CustomEvent).detail.action)),
        );

        press(editor.dom, { key: "ArrowUp" });
        press(editor.dom, { key: "ArrowDown" });
        expect(commands).toEqual(["prev", "next"]);
    });

    test("without a previous/next binding the arrows keep their default behavior", () => {
        const pc = make();
        const entry = pc.addPrompt(makeEntry({ label: "a", content: plain("one\ntwo") }));
        const editor = editorOf(pc, entry) as StubEditor;
        let fired = 0;
        pc.addEventListener("command", () => fired++);

        setCursor(editor, 0);
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
        const editor = editorOf(pc, entry) as StubEditor;
        let fired = 0;
        pc.addEventListener("command", () => fired++);

        setCursor(editor, 0);
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
        const editor = editorOf(pc, entry) as StubEditor;
        const commands: string[] = [];
        pc.addEventListener("command", (e) =>
            commands.push(actionName((e as CustomEvent).detail.action)),
        );

        setCursor(editor, 0);
        press(editor.dom, { key: "ArrowUp" });
        expect(commands).toEqual(["top"]);
    });

    test("with the real editor, ArrowUp on the first line fires previous instead of moving the cursor", () => {
        const pc = track(document.createElement("prompt-collection") as PromptCollection);
        document.body.append(pc);
        const entry = makeEntry({
            label: "a",
            content: plain("one\ntwo"),
            bindings: { Previous: "prev-history" },
        });
        pc.addPrompt(entry);
        const editor = editorOf(pc, entry)!;
        const commands: string[] = [];
        pc.addEventListener("command", (e) =>
            commands.push(actionName((e as CustomEvent).detail.action)),
        );
        const press = (key: string) =>
            editor.dom
                .querySelector(".cm-content")!
                .dispatchEvent(
                    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
                );

        // Cursor on the second line: plain cursor motion, no command.
        setCursor(editor, 5);
        press("ArrowUp");
        expect(commands).toEqual([]);
        expect(editor.getSelection?.()).toEqual({ start: 0, end: 0 });

        // Cursor back on the first line: the command fires, cursor untouched.
        press("ArrowUp");
        expect(commands).toEqual(["prev-history"]);
        expect(editor.getSelection?.()).toEqual({ start: 0, end: 0 });
    });
});

describe("prompt-collection — composition (real CodeMirror)", () => {
    // A dead key ("^" then "u" for "û") composes: "^" sits in the text,
    // provisionally, until the "u". The driver answers every change, "^"
    // included: an update then would end the composition, "^" left behind.
    async function setup() {
        const { EditorView } = await import("@codemirror/view");
        const pc = track(document.createElement("prompt-collection") as PromptCollection);
        document.body.append(pc);
        const entry = makeEntry({ label: "a", content: plain("ls ") });
        pc.addPrompt(entry);
        const editor = editorOf(pc, entry)!;
        const view = EditorView.findFromDOM(editor.dom)!;
        const transactions: unknown[] = [];
        const dispatch = view.dispatch.bind(view);
        view.dispatch = ((...args: Parameters<typeof dispatch>) => {
            transactions.push(args);
            dispatch(...args);
        }) as typeof view.dispatch;
        // (CodeMirror's own composition state: what `view.composing` reads.)
        const compose = (on: boolean) => {
            (view as any).inputState.composing = on ? 1 : -1;
        };
        return { pc, entry, editor, view, transactions, compose };
    }

    test("an answer that changes nothing changes nothing", async () => {
        const { pc, entry, editor, transactions } = await setup();
        setCursor(editor, 3);
        transactions.length = 0;
        pc.setValue(entry, { parts: [{ text: "ls " }], selection: { start: 3, end: 3 } });
        expect(transactions).toEqual([]);
    });

    test("the same highlights over new text are applied anew", async () => {
        const { pc, entry, editor } = await setup();
        const styled = (text: string) => ({
            parts: [{ text, style: "blue" }, { text: " x" }],
        });
        pc.setValue(entry, styled("ls"));
        // (Replacing the whole text collapses the old marks: they must be set again.)
        pc.setValue(entry, styled("cd"));
        const marks = [...editor.dom.querySelectorAll<HTMLElement>(".cm-line span[style]")];
        expect(marks.map((m) => m.textContent)).toEqual(["cd"]);
    });

    test("while composing, the driver's text and selection are dropped", async () => {
        const { pc, entry, editor, view, compose } = await setup();
        view.dispatch({ changes: { from: 3, insert: "^" }, selection: { anchor: 4 } });
        compose(true);
        // (A stale answer, say: it would replace the composed text.)
        pc.setValue(entry, { parts: [{ text: "ls x" }], selection: { start: 1, end: 1 } });
        expect(editorOf(pc, entry)?.getValue()).toBe("ls ^");
        expect(editor.getSelection?.()).toEqual({ start: 4, end: 4 });
        compose(false);
        pc.setValue(entry, { parts: [{ text: "ls x" }], selection: { start: 1, end: 1 } });
        expect(editorOf(pc, entry)?.getValue()).toBe("ls x");
        expect(editor.getSelection?.()).toEqual({ start: 1, end: 1 });
    });
});

describe("prompt-collection — edge styles (real CodeMirror)", () => {
    // (Bold and italic: happy-dom keeps those in a style attribute, unlike
    // the oklch() colours.)
    async function setup(content: InteractiveStructuredText) {
        const { EditorView } = await import("@codemirror/view");
        const pc = track(document.createElement("prompt-collection") as PromptCollection);
        document.body.append(pc);
        const entry = makeEntry({ label: "a", content });
        pc.addPrompt(entry);
        const editor = editorOf(pc, entry)!;
        const view = EditorView.findFromDOM(editor.dom)!;
        // The styled elements in the line, outermost first, with their text.
        const styled = () =>
            [...editor.dom.querySelectorAll<HTMLElement>(".cm-line [style]")].map((el) => [
                el.getAttribute("style")?.replace(/;$/, ""),
                el.textContent,
            ]);
        // The styles the ghost text would inherit, up to the editor's root.
        const ghostStyles = () => {
            const ghost = editor.dom.querySelector(".cm-filigrane");
            expect(ghost).not.toBeNull();
            const styles: string[] = [];
            for (let el = ghost!.parentElement; el && el !== editor.dom; el = el.parentElement) {
                const style = el.getAttribute("style");
                if (style && style !== "tab-size: 4;") {
                    styles.push(style);
                }
            }
            return styles;
        };
        return { pc, entry, editor, view, styled, ghostStyles };
    }

    const bold = styleToCss(th.calculateStyle("bold"));
    const italic = styleToCss(th.calculateStyle("italic"));

    test("the edge parts absorb typed text, but the ghost text is unstyled", async () => {
        const { entry, view, styled, ghostStyles } = await setup({
            parts: [{ text: "ls", style: "bold" }, { text: " " }, { text: "-l", style: "italic" }],
        });
        promptCell(entry).input.content.filigrane = "ls -la";
        entry.fire();
        expect(ghostStyles()).toEqual([]);

        // Typed at the end: in the last part's style; the ghost still unstyled.
        view.dispatch({ changes: { from: 5, insert: "a" } });
        expect(styled()).toEqual([
            [bold, "ls"],
            [italic, "-la"],
        ]);
        // Typed at the start: in the first part's style.
        view.dispatch({ changes: { from: 0, insert: "x" } });
        expect(styled()).toEqual([
            [bold, "xls"],
            [italic, "-la"],
        ]);
        // Typed at an inner boundary: in neither.
        view.dispatch({ changes: { from: 3, insert: "y" } });
        expect(styled()).toEqual([
            [bold, "xls"],
            [italic, "-la"],
        ]);
    });

    test("a single part styles all the text, but not the ghost text", async () => {
        const { entry, view, styled, ghostStyles } = await setup({
            parts: [{ text: "ls", style: "bold" }],
        });
        promptCell(entry).input.content.filigrane = "ls -l";
        entry.fire();
        expect(styled()).toEqual([[bold, "ls"]]);
        expect(ghostStyles()).toEqual([]);

        view.dispatch({ changes: { from: 2, insert: " -" } });
        view.dispatch({ changes: { from: 0, insert: "x" } });
        expect(styled()).toEqual([[bold, "xls -"]]);
    });

    test("a single part styles text typed into an empty prompt", async () => {
        const { view, styled } = await setup({ parts: [{ text: "", style: "italic" }] });
        expect(styled()).toEqual([]);
        view.dispatch({ changes: { from: 0, insert: "hi" } });
        expect(styled()).toEqual([[italic, "hi"]]);
    });

    test("the parts' styles win over the base style", async () => {
        const { pc, entry, styled } = await setup({ parts: [] });
        const editor = editorOf(pc, entry)!;
        editor.setValue("abc");
        editor.setBaseStyle?.(bold);
        editor.setHighlights?.([{ start: 1, end: 2, css: italic }]);
        expect(styled()).toEqual([
            [bold, "abc"],
            [italic, "b"],
        ]);
    });
});
