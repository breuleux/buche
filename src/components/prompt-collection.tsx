// A collection of prompts as a custom element: `<prompt-collection>`.
//
//   const pc = document.createElement("prompt-collection") as PromptCollection;
//   const entry = new Entry({});
//   entry.cell.label = { text: "sh", ranges: [] };
//   entry.cell.color = "green";
//   entry.replaceCell("prompt");
//   pc.addPrompt(entry);
//   container.appendChild(pc);
//
// Each prompt is configured from an {@link Entry} (src/entry.ts) and keyed by that
// Entry object — `showPrompt`, `removePrompt`, etc. all take the Entry you added.
// The accent colour comes from the Entry's cell; the leading marker and the
// editor's initial content come from its prompt cell (its `input`: `context`
// and `content`, both StyledText). Edits to the editor flow back into the
// prompt's `input.content` (its text and selection). The
// cell's `filigrane` (a history suggestion, echoed by the prompt `configure`
// answer to a parse) shows as faded ghost text extending the content;
// ArrowRight at the end of the text accepts it.
//
//   ┌─────────────────────────────────────────────┐
//   │ $  ← prompt text (small, above the editor)  │
//   │ the active prompt's CodeMirror editor       │
//   └─────────────────────────────────────────────┘
//
// Only the active prompt is shown (the layout's tabs say whose it is, and pick
// it: see Layout). The editor is created through a swappable `editorFactory`
// (default: CodeMirror).
//
// Adding a prompt registers a reconfiguration listener on `entry.listeners`;
// mutate the Entry and call `entry.fire()` to re-read the accent and marker,
// and to reset the editor's text and cursor from the prompt's input. A
// reconfiguration that finds the cell's status `done` or `error` (the process
// closed) instead removes the prompt — its editor is spent.
//
// A prompt heeds its cell's `bindings` map (e.g. { "Ctrl+L": "clear" }):
// pressing a bound chord in the editor fires a bubbling "command" event and
// swallows the key so the editor doesn't also act on it. A binding may also be
// an object ({ command, freeze }): when a binding with `freeze` fires, the
// prompt's content turns "frozen" — read-only, but styled to show the
// condition is temporary — commands keep firing but typing is dead — until the
// next prompt `configure` (the Entry's reconfiguration) resets the editability.
// (An InteractiveStyledText carries this `editability`; a prompt defaults to
// "editable", echos are "readonly" — all they support for now.)
//
// Events (all bubble):
//   "textchange"    detail: { entry, text, selection }              — a prompt's editor text changed
//   "command"       detail: { command, event, entry, text, selection }
//                                                                  — a bound chord was pressed
//
// Appearance lives in the companion stylesheet `prompt-collection.css` (or the
// consolidated components.css).

import { defaultKeymap, deleteGroupBackward, history, historyKeymap } from "@codemirror/commands";
import {
    Compartment,
    EditorState,
    type Extension,
    Prec,
    StateEffect,
    StateField,
} from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap, WidgetType } from "@codemirror/view";
import type { DomProps } from "myjsx/jsx-runtime";
import { isSpent } from "../cell.ts";
import { PromptCell } from "../cells/prompt.ts";
import { defaultTheme, resolveColor, styleToCss } from "../color.ts";
import type { Entry } from "../entry.ts";
import { chordFromEvent, normalizeChord } from "../keychord.ts";
import type { HighlightRange, InteractiveStyledText, Selection, StyledText } from "../types.ts";
import { buildStyledText } from "./utils.tsx";

/** The cell of an entry of the collection, if it is a prompt. */
function promptOf(entry: Entry): PromptCell | null {
    return entry.cell instanceof PromptCell ? entry.cell : null;
}

// ── Key bindings ────────────────────────────────────────────────────────────
// A prompt's Entry carries a `bindings` map like { "Ctrl+L": "clear" }. When a
// bound chord is pressed in that prompt's editor, a bubbling "command" event is
// fired carrying the command name, the keyboard event and the Entry. Chord
// parsing is shared with the global bindings (see keychord.ts).
//
// Bare ArrowUp on the first line and bare ArrowDown on the last line are also
// matched as the virtual chords "previous" and "next" (no such physical keys
// exist; the names come from history navigation). A binding on "previous"/
// "next" therefore fires exactly at those line boundaries; with no such binding
// the arrow keys fall through to the editor's ordinary cursor motion.

/** A resolved colorization span: a `[start, end)` range with an inline style. */
export interface StyleSpan {
    start: number;
    end: number;
    /** Inline CSS declaration string applied to the span. */
    css: string;
    /** Open start boundary: grows to absorb text inserted at `start`. */
    inclusiveStart?: boolean;
    /** Open end boundary: grows to absorb text inserted at `end`. */
    inclusiveEnd?: boolean;
}

/** A minimal editor handle the collection drives; the default is CodeMirror. */
export interface PromptEditor {
    /** The editor's root element, inserted into the prompt row. */
    dom: HTMLElement;
    getValue(): string;
    setValue(value: string): void;
    focus(): void;
    destroy(): void;
    /** Colorize spans over the current text. Optional; no-op if unsupported. */
    setHighlights?(spans: StyleSpan[]): void;
    /**
     * Apply a style to the whole editor, including text the user will type
     * (`""` clears it). Used for fully-open ranges, which have no text to anchor
     * a span to. Optional; no-op if unsupported.
     */
    setBaseStyle?(css: string): void;
    /** Apply a selection (`start === end` is a plain cursor). Optional. */
    setSelection?(selection: Selection): void;
    /** The current selection range. Optional. */
    getSelection?(): Selection;
    /**
     * Show ghost text: a suggestion extending the current text (e.g. a history
     * entry). The suffix past the current text is rendered inline, faded; it
     * hides itself whenever the text stops being a prefix of it. `null` (or a
     * non-extension) hides the ghost. Optional; no-op if unsupported.
     */
    setFiligrane?(filigrane: string | null): void;
    /**
     * Apply an editability status ("editable" typing live; "readonly" and
     * "frozen" both kill typing but keep cursor movement and bound commands
     * — "frozen", set when a freezing binding fires, is styled differently to
     * denote the temporary condition). Optional; no-op if unsupported.
     */
    setEditability?(editability: Editability): void;
}

/** How an InteractiveStyledText (a prompt's content) can be edited. */
export type Editability = "readonly" | "editable" | "frozen";

export type EditorFactory = (options: {
    doc: string;
    onChange?: (value: string) => void;
}) => PromptEditor;

interface Row {
    entry: Entry;
    row: HTMLElement; // [marker; editor]
    marker: HTMLElement;
    editor: PromptEditor;
    /** The reconfiguration callback registered on `entry.listeners`. */
    listener: (entry: Entry) => void;
}

// ── Events ────────────────────────────────────────────────────────────────
// `detail` shapes and typed `CustomEvent` aliases for the events dispatched by
// {@link PromptCollection}. All events bubble.

/** `detail` of the "textchange" event: a prompt's editor text changed. */
export interface PromptTextChangeDetail {
    /** The Entry of the prompt whose text changed (not necessarily the active one). */
    entry: Entry;
    /** The editor's new full text. */
    text: string;
    /** The current selection (`start === end` is the cursor); a point at the
     *  end of `text` if the editor can't report it. */
    selection: Selection;
}
/** `detail` of the "command" event: a bound key chord was pressed in a prompt. */
export interface PromptCommandDetail {
    /** The command name the chord is bound to (the binding map's value). */
    command: string;
    /** The originating keyboard event. */
    event: KeyboardEvent;
    /** The Entry of the prompt the chord was pressed in. */
    entry: Entry;
    /** The prompt's current editor text. */
    text: string;
    /** The prompt's current selection (`start === end` is the cursor). */
    selection: Selection;
}

export type PromptTextChangeEvent = CustomEvent<PromptTextChangeDetail>;
export type PromptCommandEvent = CustomEvent<PromptCommandDetail>;

/** Typed event map for {@link PromptCollection} (drives `addEventListener`). */
export interface PromptCollectionEventMap {
    textchange: PromptTextChangeEvent;
    command: PromptCommandEvent;
}

let darkTheme: Extension | null = null;

// Colorization decorations: a state field holding a decoration set that is
// replaced wholesale whenever `setSpansEffect` is dispatched.
const setSpansEffect = StateEffect.define<StyleSpan[]>();

/** Spans as the editor shows them: clamped to the document (`len`), the empty
 *  and inverted ones dropped, in order. */
function normalizeSpans(spans: StyleSpan[], len: number): Required<StyleSpan>[] {
    return spans
        .map((s) => ({
            start: Math.max(0, Math.min(len, s.start)),
            end: Math.max(0, Math.min(len, s.end)),
            css: s.css,
            inclusiveStart: s.inclusiveStart ?? false,
            inclusiveEnd: s.inclusiveEnd ?? false,
        }))
        .filter((s) => s.start < s.end)
        .sort((a, b) => a.start - b.start || a.end - b.end);
}

/** The spans an editor shows now (moved along with the edits since they were set). */
function shownSpans(deco: DecorationSet): Required<StyleSpan>[] {
    const spans: Required<StyleSpan>[] = [];
    for (let it = deco.iter(); it.value; it.next()) {
        const spec = it.value.spec;
        spans.push({
            start: it.from,
            end: it.to,
            css: spec.attributes?.style ?? "",
            inclusiveStart: spec.inclusiveStart ?? false,
            inclusiveEnd: spec.inclusiveEnd ?? false,
        });
    }
    return spans;
}

const spansField = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(deco, tr) {
        deco = deco.map(tr.changes);
        for (const effect of tr.effects) {
            if (effect.is(setSpansEffect)) {
                const marks = normalizeSpans(effect.value, tr.state.doc.length).map((s) =>
                    Decoration.mark({
                        attributes: { style: s.css },
                        // Open boundaries absorb text inserted at the edge as
                        // the decoration is re-mapped across document changes.
                        inclusiveStart: s.inclusiveStart,
                        inclusiveEnd: s.inclusiveEnd,
                    }).range(s.start, s.end),
                );
                deco = Decoration.set(marks);
            }
        }
        return deco;
    },
    provide: (f) => EditorView.decorations.from(f),
});

// Ghost text (filigrane): a state field holding the suggestion, providing a
// read-only inline widget with the suffix past the current text. Recomputed on
// every doc change, so it follows the user's typing and disappears the moment
// the text stops extending the suggestion (the shell sends a new one per parse).
const setFiligraneEffect = StateEffect.define<string | null>();

class FiligraneWidget extends WidgetType {
    constructor(readonly text: string) {
        super();
    }
    eq(other: FiligraneWidget): boolean {
        return other.text === this.text;
    }
    toDOM(): HTMLElement {
        const span = document.createElement("span");
        span.className = "cm-filigrane";
        span.textContent = this.text;
        span.setAttribute("aria-hidden", "true");
        return span;
    }
}

function filigraneDeco(filigrane: string | null, text: string): DecorationSet {
    if (!filigrane?.startsWith(text) || filigrane.length <= text.length) {
        return Decoration.none;
    }
    return Decoration.set([
        Decoration.widget({
            widget: new FiligraneWidget(filigrane.slice(text.length)),
            side: 1,
        }).range(text.length),
    ]);
}

const filigraneField = StateField.define<{ filigrane: string | null; deco: DecorationSet }>({
    create: () => ({ filigrane: null, deco: Decoration.none }),
    update(value, tr) {
        let filigrane = value.filigrane;
        for (const effect of tr.effects) {
            if (effect.is(setFiligraneEffect)) {
                filigrane = effect.value;
            }
        }
        if (!filigrane) {
            return value.filigrane ? { filigrane: null, deco: Decoration.none } : value;
        }
        if (!tr.docChanged && filigrane === value.filigrane) {
            return value;
        }
        return { filigrane, deco: filigraneDeco(filigrane, tr.state.doc.toString()) };
    },
    provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

// Accept the ghost text, if showing: the selection must be an empty cursor at
// the end of the text and the filigrane must extend it. Inserts the suffix and
// parks the cursor at the new end. The filigrane is kept: fully typed, the
// ghost hides, and deleting back re-reveals it (the shell resends per parse).
function acceptFiligrane(view: EditorView): boolean {
    const { state } = view;
    if (state.readOnly) {
        return false;
    }
    const { empty, head } = state.selection.main;
    const text = state.doc.toString();
    if (!empty || head !== state.doc.length) {
        return false;
    }
    const filigrane = state.field(filigraneField).filigrane;
    if (!filigrane?.startsWith(text) || filigrane.length <= text.length) {
        return false;
    }
    view.dispatch({
        changes: { from: text.length, insert: filigrane.slice(text.length) },
        selection: { anchor: filigrane.length },
        scrollIntoView: true,
    });
    return true;
}

// Default editor: a CodeMirror EditorView. Built lazily so merely importing this
// module never touches CodeMirror's runtime (keeps injected-editor tests light).
const codeMirrorEditor: EditorFactory = ({ doc, onChange }) => {
    darkTheme ??= EditorView.theme(
        {
            "&": { color: "#d4d4d4", backgroundColor: "transparent" },
            ".cm-content": { caretColor: "#d4d4d4", padding: "0", lineHeight: "20px" },
            ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#d4d4d4" },
            ".cm-line": { padding: "0" },
        },
        { dark: true },
    );
    // A reconfigurable inline style on `.cm-content` (the editor-wide base style).
    // An inline style beats the theme's class rules, and applies to typed text.
    const baseStyle = new Compartment();
    // Reconfigurable read-only mode (bindings that `freeze` the prompt). Only
    // user input is blocked; programmatic resets (a prompt `configure`) go through.
    const readOnly = new Compartment();
    const view = new EditorView({
        state: EditorState.create({
            doc,
            extensions: [
                Prec.highest(
                    keymap.of([
                        // At the end of the text, ArrowRight accepts the ghost
                        // text (filigrane) instead of moving past the last
                        // character — like other ghost-text UIs. It defers to
                        // the default cursor move whenever no ghost is showing
                        // (cursor not at the end, or the text stopped
                        // extending the suggestion).
                        {
                            key: "ArrowRight",
                            run: (v) => acceptFiligrane(v),
                        },
                        // Escape clears the field (and the ghost text); a no-op
                        // on an already-empty prompt, so the key falls through.
                        {
                            key: "Escape",
                            run: (v) => {
                                const len = v.state.doc.length;
                                if (!len || v.state.readOnly) {
                                    return false;
                                }
                                v.dispatch({
                                    changes: { from: 0, to: len, insert: "" },
                                    selection: { anchor: 0 },
                                    effects: setFiligraneEffect.of(null),
                                });
                                return true;
                            },
                        },
                    ]),
                ),
                history(),
                keymap.of([
                    // C-w deletes the word before the cursor, as in a shell.
                    { key: "Ctrl-w", run: deleteGroupBackward },
                    ...defaultKeymap,
                    ...historyKeymap,
                ]),
                EditorView.lineWrapping,
                spansField,
                filigraneField,
                baseStyle.of([]),
                readOnly.of([]),
                darkTheme,
                EditorView.updateListener.of((u) => {
                    if (u.docChanged) {
                        onChange?.(u.state.doc.toString());
                    }
                }),
            ],
        }),
    });
    // What the driver resets (on every answer to a keystroke) mostly hasn't
    // changed: such updates are skipped. Besides being wasted, any of them
    // mid-composition (a dead key's "^" waiting for its "u", an IME) would end
    // it, its provisional text left behind ("^û"). And while composing, the
    // driver's text and selection answer a provisional state: they're dropped
    // (the composed text, once there, is sent, and answered, in turn).
    let editability: Editability = "editable";
    let css = "";
    return {
        dom: view.dom,
        getValue: () => view.state.doc.toString(),
        setValue: (value) => {
            if (view.composing || value === view.state.doc.toString()) {
                return;
            }
            view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
        },
        setHighlights: (value) => {
            const { state } = view;
            const next = normalizeSpans(value, state.doc.length);
            if (JSON.stringify(next) === JSON.stringify(shownSpans(state.field(spansField)))) {
                return;
            }
            view.dispatch({ effects: setSpansEffect.of(value) });
        },
        setFiligrane: (filigrane) => view.dispatch({ effects: setFiligraneEffect.of(filigrane) }),
        setEditability: (value) => {
            if (value === editability) {
                return;
            }
            editability = value;
            // The frozen/readonly classes must come through the
            // editorAttributes facet: CodeMirror rewrites the root's `class`
            // attribute on every focus change, which would wipe a class set
            // directly on view.dom.
            view.dispatch({
                effects: readOnly.reconfigure(
                    value === "editable"
                        ? []
                        : [
                              EditorState.readOnly.of(true),
                              EditorView.editorAttributes.of({
                                  class: value === "frozen" ? "cm-frozen" : "cm-readonly",
                              }),
                          ],
                ),
            });
        },
        setBaseStyle: (value) => {
            if (value === css) {
                return;
            }
            css = value;
            view.dispatch({
                effects: baseStyle.reconfigure(
                    value ? EditorView.contentAttributes.of({ style: value }) : [],
                ),
            });
        },
        setSelection: (selection) => {
            const len = view.state.doc.length;
            const start = Math.max(0, Math.min(len, selection.start));
            const end = Math.max(start, Math.min(len, selection.end));
            const { anchor, head } = view.state.selection.main;
            if (view.composing || (anchor === start && head === end)) {
                return;
            }
            view.dispatch({ selection: { anchor: start, head: end } });
        },
        getSelection: () => {
            const { from, to } = view.state.selection.main;
            return { start: from, end: to };
        },
        focus: () => view.focus(),
        destroy: () => view.destroy(),
    };
};

export class PromptCollection extends HTMLElement {
    /** How each prompt's editor is created. Swap before adding prompts. */
    editorFactory: EditorFactory = codeMirrorEditor;

    /** Theme used to resolve a {@link StyledText} range's accent into
     *  concrete colors. */
    private readonly theme = defaultTheme;

    private initialized = false;
    private promptsEl!: HTMLElement;
    // Prompts are keyed by their Entry object — the Entry is the prompt's identity.
    private rows = new Map<Entry, Row>();
    private order: Entry[] = [];
    private active: Entry | null = null;
    // Activation history, most recent last: removing the active prompt falls
    // back to the one active before it.
    private history: Entry[] = [];
    // True while pushing an Entry's content into an editor, to suppress the
    // editor's change→content sync (which would otherwise feed back on a reset).
    private applyingContent = false;

    connectedCallback(): void {
        this.ensureSetup();
    }

    // Typed event listeners for this element's custom events (see
    // {@link PromptCollectionEventMap}); falls back to the standard signature.
    addEventListener<K extends keyof PromptCollectionEventMap>(
        type: K,
        listener: (this: PromptCollection, ev: PromptCollectionEventMap[K]) => void,
        options?: boolean | AddEventListenerOptions,
    ): void;
    addEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions,
    ): void;
    addEventListener(type: string, listener: unknown, options?: unknown): void {
        super.addEventListener(
            type,
            listener as EventListenerOrEventListenerObject,
            options as boolean | AddEventListenerOptions,
        );
    }

    removeEventListener<K extends keyof PromptCollectionEventMap>(
        type: K,
        listener: (this: PromptCollection, ev: PromptCollectionEventMap[K]) => void,
        options?: boolean | EventListenerOptions,
    ): void;
    removeEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | EventListenerOptions,
    ): void;
    removeEventListener(type: string, listener: unknown, options?: unknown): void {
        super.removeEventListener(
            type,
            listener as EventListenerOrEventListenerObject,
            options as boolean | EventListenerOptions,
        );
    }

    private ensureSetup(): void {
        if (this.initialized) {
            return;
        }
        this.initialized = true;
        this.replaceChildren();

        this.promptsEl = document.createElement("div");
        this.promptsEl.className = "prompt-collection-prompts";
        this.append(this.promptsEl);
    }

    // ── Prompts ───────────────────────────────────────────────────────────────

    /** The prompt entries, in the order they were added. */
    get prompts(): Entry[] {
        this.ensureSetup();
        return [...this.order];
    }

    /** The active prompt's entry, or null if empty. */
    get activePrompt(): Entry | null {
        this.ensureSetup();
        return this.active;
    }

    /** Add a prompt for `entry`. The first prompt added becomes active.
     *  Returns the same Entry (the prompt's handle). */
    addPrompt(entry: Entry): Entry {
        this.ensureSetup();
        if (this.rows.has(entry)) {
            return entry;
        }

        const marker = document.createElement("div");
        marker.className = "prompt-collection-marker";

        const content: InteractiveStyledText = promptOf(entry)?.input.content ?? {
            text: "",
            ranges: [],
        };

        const editorHost = document.createElement("div");
        editorHost.className = "prompt-collection-editor";
        const editor = this.editorFactory({
            doc: content.text,
            // Keep the Entry's prompt content (text and selection) in sync with the
            // editor as the user edits. Suppressed while we push content into the
            // editor ourselves (see `applyingContent`), so a reset can't feed back.
            onChange: (value) => {
                if (this.applyingContent) {
                    return;
                }
                const sel = this.rows.get(entry)?.editor.getSelection?.();
                const prompt = promptOf(entry);
                if (prompt) {
                    const promptContent = prompt.input.content;
                    promptContent.text = value;
                    if (sel != null) {
                        promptContent.selection = sel;
                    }
                    // A suggestion the text no longer extends is stale —
                    // divergent typing and Escape (emptied text) drop it (the
                    // fresh one comes with the next parse answer).
                    if (
                        promptContent.filigrane &&
                        (value === "" || !promptContent.filigrane.startsWith(value))
                    ) {
                        promptContent.filigrane = undefined;
                    }
                }
                this.dispatchEvent(
                    new CustomEvent<PromptTextChangeDetail>("textchange", {
                        detail: {
                            entry,
                            text: value,
                            selection: sel ?? { start: value.length, end: value.length },
                        },
                        bubbles: true,
                    }),
                );
            },
        });
        editorHost.appendChild(editor.dom);

        const row = document.createElement("div");
        row.className = "prompt-collection-prompt";
        row.hidden = true;
        // Only the active row is visible, so only it takes part in focus
        // navigation (see focus.ts); "prompt" is its kind in the focus history.
        row.setAttribute("focusable", "prompt");
        row.append(marker, editorHost);
        // Heed the Entry's key bindings. Capture phase so a bound chord fires the
        // "command" event before the editor (CodeMirror) can act on the key.
        row.addEventListener("keydown", (e) => this.handleBindings(entry, e), true);
        this.promptsEl.appendChild(row);

        // Re-read the prompt whenever the Entry is reconfigured (entry.fire()).
        const listener = (): void => this.reconfigure(entry);
        entry.listeners.push(listener);

        const rowEntry: Row = { entry, row, marker, editor, listener };
        this.rows.set(entry, rowEntry);
        this.order.push(entry);

        // Render the leading marker and apply the initial styled content.
        this.renderMarker(rowEntry, entry);
        this.applyContent(editor, content);
        editor.setEditability?.(content.editability ?? "editable");
        this.applyFiligrane(rowEntry);
        if (this.active === null) {
            this.activate(entry, false);
        }
        return entry;
    }

    /** Remove a prompt; if it was active, the prompt that was active before it
     *  becomes active (or the first one, if none of those remain). */
    removePrompt(entry: Entry): void {
        this.ensureSetup();
        const row = this.rows.get(entry);
        if (!row) {
            return;
        }
        entry.listeners = entry.listeners.filter((l) => l !== row.listener);
        row.editor.destroy();
        row.row.remove();
        this.rows.delete(entry);
        this.order = this.order.filter((x) => x !== entry);
        this.history = this.history.filter((x) => x !== entry);
        if (this.active === entry) {
            this.active = null;
            const next = this.history.at(-1) ?? this.order[0];
            if (next) {
                this.activate(next, false);
            }
        }
    }

    /** Switch to a prompt and (unless `focus` is false) focus its editor.
     *  No-op for an unknown entry. */
    showPrompt(entry: Entry, focus = true): void {
        this.activate(entry, focus);
    }

    /** The entry whose prompt `el` (a prompt's element) is, if any. */
    entryOf(el: Element): Entry | null {
        for (const [entry, row] of this.rows) {
            if (row.row === el) {
                return entry;
            }
        }
        return null;
    }

    /** The element of a prompt (its row: marker + editor), or null. */
    promptElement(entry: Entry): HTMLElement | null {
        this.ensureSetup();
        return this.rows.get(entry)?.row ?? null;
    }

    private activate(entry: Entry, focus: boolean): void {
        this.ensureSetup();
        if (!this.rows.has(entry)) {
            return;
        }
        this.active = entry;
        this.history = this.history.filter((x) => x !== entry);
        this.history.push(entry);
        for (const [e, row] of this.rows) {
            row.row.hidden = e !== entry;
        }
        if (focus) {
            this.rows.get(entry)?.editor.focus();
        }
    }

    // Match a keydown against the Entry's `bindings` map. On a match, swallow the
    // key (so the editor doesn't also act on it) and fire a bubbling "command"
    // event carrying the command name, the keyboard event and the Entry. The
    // pressed chord is tried first; at a line boundary the virtual chord
    // ("previous"/"next", see virtualChord) is tried as a fallback, so an
    // explicit ArrowUp/ArrowDown binding still wins everywhere.
    private handleBindings(entry: Entry, e: KeyboardEvent): void {
        const bindings = promptOf(entry)?.bindings;
        if (!bindings) {
            return;
        }
        const chords = [chordFromEvent(e)];
        const virtual = this.virtualChord(entry, e);
        if (virtual) {
            chords.push(virtual);
        }
        for (const chord of chords) {
            for (const [key, binding] of Object.entries(bindings)) {
                if (normalizeChord(key) === chord) {
                    e.preventDefault();
                    e.stopPropagation();
                    const command = typeof binding === "string" ? binding : binding.command;
                    const editor = this.rows.get(entry)?.editor;
                    // A freezing binding marks the prompt's content "frozen"
                    // (read-only, styled as temporary) as the command fires;
                    // the next reconfiguration resets it — the driver's
                    // submit reset replaces the content whole, editability
                    // (and filigrane) included.
                    if (typeof binding === "object" && binding.freeze) {
                        const content = promptOf(entry)?.input.content;
                        if (content) {
                            content.editability = "frozen";
                        }
                        editor?.setEditability?.("frozen");
                    }
                    const text = editor?.getValue() ?? "";
                    const selection = editor?.getSelection?.() ?? {
                        start: text.length,
                        end: text.length,
                    };
                    this.dispatchEvent(
                        new CustomEvent<PromptCommandDetail>("command", {
                            detail: { command, event: e, entry, text, selection },
                            bubbles: true,
                        }),
                    );
                    return;
                }
            }
        }
    }

    // Virtual chord for a bare ArrowUp/ArrowDown pressed at a line boundary:
    // "previous" when the cursor is on the first line, "next" when it is on the
    // last (null otherwise, or for modified arrows, or unknown editors). The
    // cursor's line is inferred from the text around its offset.
    private virtualChord(entry: Entry, e: KeyboardEvent): string | null {
        if (e.ctrlKey || e.altKey || e.shiftKey || e.metaKey) {
            return null;
        }
        const virtual = e.key === "ArrowUp" ? "previous" : e.key === "ArrowDown" ? "next" : null;
        if (!virtual) {
            return null;
        }
        const editor = this.rows.get(entry)?.editor;
        if (!editor) {
            return null;
        }
        const text = editor.getValue();
        const position = editor.getSelection?.().end ?? text.length;
        const before = text.slice(0, position);
        const after = text.slice(position);
        if (virtual === "previous" && before.includes("\n")) {
            return null;
        }
        if (virtual === "next" && after.includes("\n")) {
            return null;
        }
        return virtual;
    }

    // ── Reconfiguration ─────────────────────────────────────────────────────

    // Re-read an Entry's accent and marker after it was reconfigured
    // (a prompt `configure`), reset the editor's text and cursor from the
    // prompt's `content` (if any), and unblock a frozen editor.
    private reconfigure(entry: Entry): void {
        const row = this.rows.get(entry);
        if (!row) {
            return;
        }
        // A prompt whose process has terminated (its close reaches the prompt:
        // status done or error) has no further use: drop its editor.
        if (isSpent(entry.cell.status.status)) {
            this.removePrompt(entry);
            return;
        }
        this.renderMarker(row, entry);

        // Reset the editor from `content`: its text, colorization and
        // selection. Guarded so the resulting change doesn't sync back into it.
        const content = promptOf(entry)?.input.content;
        if (content) {
            this.applyingContent = true;
            try {
                this.setValue(entry, content);
            } finally {
                this.applyingContent = false;
            }
        }
        // Reconfiguration takes the content's editability: a frozen prompt (a
        // freezing binding fired) — or anything else the driver asked for —
        // resets to it; a content without one is a prompt, and editable is
        // the prompt default.
        row.editor.setEditability?.(content?.editability ?? "editable");
        this.applyFiligrane(row);
    }

    // Push the Entry's ghost text (`content.filigrane`) into its editor;
    // cleared when the Entry has none. No-op on editors that don't support it.
    private applyFiligrane(row: Row): void {
        row.editor.setFiligrane?.(promptOf(row.entry)?.input.content.filigrane ?? null);
    }

    // ── Editor access ─────────────────────────────────────────────────────────

    /**
     * Set a prompt's editor value. A plain string sets just the text. A
     * {@link StyledText} additionally colorizes the text (resolving each range's
     * accent through {@link calculateStyle}) and, when a `selection` is given,
     * moves the selection there.
     */
    setValue(entry: Entry, value: string | InteractiveStyledText): void {
        this.ensureSetup();
        const row = this.rows.get(entry);
        if (!row) {
            return;
        }
        if (typeof value === "string") {
            row.editor.setValue(value);
            return;
        }
        row.editor.setValue(value.text);
        this.applyContent(row.editor, value);
    }

    // Apply an InteractiveStyledText's colorization and selection to an editor.
    private applyContent(editor: PromptEditor, content: InteractiveStyledText): void {
        const { base, spans } = this.resolveContent(content.ranges ?? [], content.text);
        editor.setBaseStyle?.(base);
        editor.setHighlights?.(spans);
        if (content.selection != null) {
            editor.setSelection?.(content.selection);
        }
    }

    /**
     * Resolve styled-text ranges into a whole-editor base style plus concrete
     * colorization spans.
     *
     *   - A *fully* open range (`start` and `end` both `null`) styles the entire
     *     editor, including text the user will type, so it becomes the base style
     *     rather than a span (which would need text to anchor to).
     *   - A partially open boundary resolves to the text edge (0 / length) and is
     *     marked *open*, so its span grows to cover text typed at that edge.
     *
     * Ranges whose accent cannot be parsed are skipped rather than aborting the
     * whole set.
     */
    private resolveContent(
        ranges: HighlightRange[],
        text: string,
    ): { base: string; spans: StyleSpan[] } {
        const baseParts: string[] = [];
        const spans: StyleSpan[] = [];
        for (const range of ranges) {
            let css: string;
            try {
                css = styleToCss(this.theme.calculateStyle(range.style));
            } catch {
                continue;
            }
            if (!css) {
                continue;
            }
            if (range.start == null && range.end == null) {
                baseParts.push(css);
            } else {
                spans.push({
                    start: range.start ?? 0,
                    end: range.end ?? text.length,
                    css,
                    inclusiveStart: range.start == null,
                    inclusiveEnd: range.end == null,
                });
            }
        }
        return { base: baseParts.join("; "), spans };
    }

    // ── Internals ──────────────────────────────────────────────────────────────

    // Render a StyledText leading marker into the row's marker (empty when
    // absent), and expose the Entry's accent as `--prompt-accent` on the row
    // itself (custom properties inherit downward, and the rectangle styles read
    // it on the row) so the stylesheet can tint the rectangle and top line.
    private renderMarker(row: Row, entry: Entry): void {
        const styled = promptOf(entry)?.input.context;
        if (styled?.text) {
            row.marker.replaceChildren(buildStyledText(styled, this.theme));
        } else {
            row.marker.replaceChildren();
        }
        const accent = entry.cell.color ? resolveColor(entry.cell.color) : "";
        if (accent) {
            row.row.style.setProperty("--prompt-accent", accent);
        } else {
            row.row.style.removeProperty("--prompt-accent");
        }
    }
}

if (typeof customElements !== "undefined") {
    if (!customElements.get("prompt-collection")) {
        customElements.define("prompt-collection", PromptCollection);
    }
}

declare module "myjsx/jsx-runtime" {
    namespace JSX {
        interface CustomElements {
            "prompt-collection": DomProps<PromptCollection>;
        }
    }
}
