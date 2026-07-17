// A collection of prompts as a custom element: `<prompt-collection>`.
//
//   const pc = document.createElement("prompt-collection") as PromptCollection;
//   const entry = new Entry({});
//   entry.echo.label = "sh";
//   entry.echo.color = "green";
//   entry.setPrompt(new Prompt({ prompt: { text: "$", ranges: [] } }));
//   pc.addPrompt(entry);
//   container.appendChild(pc);
//
// Each prompt is configured from an {@link Entry} (src/entry.ts) and keyed by that
// Entry object — `showPrompt`, `removePrompt`, etc. all take the Entry you added.
// The tab's label and accent colour come from the Entry's {@link Echo}; the
// leading marker and the editor's initial content come from the Entry's
// {@link Prompt} (`prompt` and `content`, both StyledText). Edits to the editor
// flow back into `entry.prompt.content.text`.
//
//   ┌─────────────────────────────────────────────┐
//   │ $  │ the active prompt's CodeMirror editor  │
//   ├─────────────────────────────────────────────┤
//   │ sh   py   notes            ← tab zone       │
//   └─────────────────────────────────────────────┘
//
// Only the active prompt is shown. Under the prompt is a tab zone: one tab per
// prompt (its label, coloured by the Echo accent while active, grey otherwise).
// Click a label to switch prompts; drag labels to reorder them. The editor is
// created through a swappable `editorFactory` (default: CodeMirror).
//
// Adding a prompt registers a reconfiguration listener on `entry.listeners`;
// mutate the Entry and call `entry.fire()` to re-read the label, accent and
// marker (the editor content is left alone so it never clobbers user edits).
//
// A prompt heeds its Entry's Prompt `bindings` map (e.g. { "Ctrl+L": "clear" }):
// pressing a bound chord in the editor fires a bubbling "command" event and
// swallows the key so the editor doesn't also act on it.
//
// Events (all bubble):
//   "promptchange"  detail: { entry: Entry }                      — active prompt changed
//   "reorder"       detail: { order: Entry[] }                     — tabs were reordered
//   "command"       detail: { command, event, entry, text, position }
//                                                                  — a bound chord was pressed
//
// Appearance lives in the companion stylesheet `prompt-collection.css` (or the
// consolidated components.css).

import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
    Compartment,
    EditorState,
    type Extension,
    Prec,
    StateEffect,
    StateField,
} from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap } from "@codemirror/view";
import type { DomProps } from "myjsx/jsx-runtime";
import { defaultTheme, styleToCss, type Theme } from "../color.ts";
import type { Entry } from "../entry.ts";
import type { HighlightRange, StyledText } from "../types.ts";
import { buildStyledText } from "./utils.tsx";

// ── Key bindings ────────────────────────────────────────────────────────────
// A prompt's Entry carries a `bindings` map like { "Ctrl+L": "clear" }. When a
// bound chord is pressed in that prompt's editor, a bubbling "command" event is
// fired carrying the command name, the keyboard event and the Entry.

/** Modifier aliases → canonical modifier name. */
const MODIFIER_ALIASES: Record<string, "ctrl" | "alt" | "shift" | "meta"> = {
    ctrl: "ctrl",
    control: "ctrl",
    alt: "alt",
    option: "alt",
    opt: "alt",
    shift: "shift",
    meta: "meta",
    cmd: "meta",
    command: "meta",
    super: "meta",
    win: "meta",
    windows: "meta",
};

const MODIFIER_ORDER = ["ctrl", "alt", "shift", "meta"] as const;

/** Normalize a single key name (case-insensitive; space → "space"). */
function normalizeKeyName(key: string): string {
    const k = key.trim();
    return k === " " ? "space" : k.toLowerCase();
}

/** A canonical chord for a keyboard event, e.g. "ctrl+shift+l". */
function chordFromEvent(e: KeyboardEvent): string {
    const parts: string[] = [];
    if (e.ctrlKey) {
        parts.push("ctrl");
    }
    if (e.altKey) {
        parts.push("alt");
    }
    if (e.shiftKey) {
        parts.push("shift");
    }
    if (e.metaKey) {
        parts.push("meta");
    }
    parts.push(normalizeKeyName(e.key));
    return parts.join("+");
}

/** Normalize a binding string like "Ctrl+L" into a canonical chord "ctrl+l". */
function normalizeChord(chord: string): string {
    const mods = new Set<string>();
    let key = "";
    for (const raw of chord.split("+")) {
        const token = raw.trim().toLowerCase();
        if (!token) {
            continue;
        }
        const mod = MODIFIER_ALIASES[token];
        if (mod) {
            mods.add(mod);
        } else {
            key = normalizeKeyName(raw);
        }
    }
    return [...MODIFIER_ORDER.filter((m) => mods.has(m)), key].filter(Boolean).join("+");
}

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
    /** Move the cursor to an offset into the text. Optional. */
    setPosition?(position: number): void;
    /** The current cursor position (offset into the text). Optional. */
    getPosition?(): number;
}

export type EditorFactory = (options: {
    doc: string;
    onChange?: (value: string) => void;
    /** Invoked when the user asks to rotate focus (-1 = previous, +1 = next). */
    onNavigate?: (direction: -1 | 1) => void;
}) => PromptEditor;

interface Row {
    entry: Entry;
    /** Stable DOM id (for the `data-prompt` attribute and drag reordering). */
    id: string;
    row: HTMLElement; // [marker][editor]
    marker: HTMLElement;
    tab: HTMLElement;
    editor: PromptEditor;
    /** The reconfiguration callback registered on `entry.listeners`. */
    listener: (entry: Entry) => void;
}

// ── Events ────────────────────────────────────────────────────────────────
// `detail` shapes and typed `CustomEvent` aliases for the events dispatched by
// {@link PromptCollection}. All events bubble.

/** `detail` of the "promptchange" event: the active prompt changed. */
export interface PromptChangeDetail {
    entry: Entry;
}
/** `detail` of the "reorder" event: the tabs were reordered. */
export interface PromptReorderDetail {
    order: Entry[];
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
    /** The prompt's current cursor position (offset into `text`). */
    position: number;
}

export type PromptChangeEvent = CustomEvent<PromptChangeDetail>;
export type PromptReorderEvent = CustomEvent<PromptReorderDetail>;
export type PromptCommandEvent = CustomEvent<PromptCommandDetail>;

/** Typed event map for {@link PromptCollection} (drives `addEventListener`). */
export interface PromptCollectionEventMap {
    promptchange: PromptChangeEvent;
    reorder: PromptReorderEvent;
    command: PromptCommandEvent;
}

let darkTheme: Extension | null = null;

// Colorization decorations: a state field holding a decoration set that is
// replaced wholesale whenever `setSpansEffect` is dispatched.
const setSpansEffect = StateEffect.define<StyleSpan[]>();
const spansField = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(deco, tr) {
        deco = deco.map(tr.changes);
        for (const effect of tr.effects) {
            if (effect.is(setSpansEffect)) {
                const len = tr.state.doc.length;
                const marks = effect.value
                    // Clamp to the document and drop empty/inverted spans.
                    .map((s) => ({
                        ...s,
                        start: Math.max(0, Math.min(len, s.start)),
                        end: Math.max(0, Math.min(len, s.end)),
                    }))
                    .filter((s) => s.start < s.end)
                    .sort((a, b) => a.start - b.start || a.end - b.end)
                    .map((s) =>
                        Decoration.mark({
                            attributes: { style: s.css },
                            // Open boundaries absorb text inserted at the edge as
                            // the decoration is re-mapped across document changes.
                            inclusiveStart: s.inclusiveStart ?? false,
                            inclusiveEnd: s.inclusiveEnd ?? false,
                        }).range(s.start, s.end),
                    );
                deco = Decoration.set(marks);
            }
        }
        return deco;
    },
    provide: (f) => EditorView.decorations.from(f),
});

// Default editor: a CodeMirror EditorView. Built lazily so merely importing this
// module never touches CodeMirror's runtime (keeps injected-editor tests light).
const codeMirrorEditor: EditorFactory = ({ doc, onChange, onNavigate }) => {
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
    const view = new EditorView({
        state: EditorState.create({
            doc,
            extensions: [
                // Cmd/Ctrl-Left/Right rotate focus across the collection's prompts.
                // High precedence so they win over CodeMirror's line-boundary moves.
                Prec.highest(
                    keymap.of([
                        {
                            key: "Mod-ArrowLeft",
                            run: () => {
                                if (!onNavigate) {
                                    return false;
                                }
                                onNavigate(-1);
                                return true;
                            },
                        },
                        {
                            key: "Mod-ArrowRight",
                            run: () => {
                                if (!onNavigate) {
                                    return false;
                                }
                                onNavigate(1);
                                return true;
                            },
                        },
                    ]),
                ),
                history(),
                keymap.of([...defaultKeymap, ...historyKeymap]),
                EditorView.lineWrapping,
                spansField,
                baseStyle.of([]),
                darkTheme,
                EditorView.updateListener.of((u) => {
                    if (u.docChanged) {
                        onChange?.(u.state.doc.toString());
                    }
                }),
            ],
        }),
    });
    return {
        dom: view.dom,
        getValue: () => view.state.doc.toString(),
        setValue: (value) =>
            view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } }),
        setHighlights: (spans) => view.dispatch({ effects: setSpansEffect.of(spans) }),
        setBaseStyle: (css) =>
            view.dispatch({
                effects: baseStyle.reconfigure(
                    css ? EditorView.contentAttributes.of({ style: css }) : [],
                ),
            }),
        setPosition: (position) => {
            const pos = Math.max(0, Math.min(view.state.doc.length, position));
            view.dispatch({ selection: { anchor: pos } });
        },
        getPosition: () => view.state.selection.main.head,
        focus: () => view.focus(),
        destroy: () => view.destroy(),
    };
};

export class PromptCollection extends HTMLElement {
    /** How each prompt's editor is created. Swap before adding prompts. */
    editorFactory: EditorFactory = codeMirrorEditor;

    /**
     * Theme used to resolve a {@link StyledText} range's accent (and tab accents)
     * into concrete colors. Defaults to the dark editor theme.
     */
    theme: Theme = defaultTheme;

    private initialized = false;
    private promptsEl!: HTMLElement;
    private tabsEl!: HTMLElement;
    // Prompts are keyed by their Entry object — the Entry is the prompt's identity.
    private rows = new Map<Entry, Row>();
    // Reverse lookup from a row's DOM id back to its Entry (for drag reordering).
    private byId = new Map<string, Entry>();
    private order: Entry[] = [];
    private active: Entry | null = null;
    private seq = 0;
    private dragEntry: Entry | null = null;

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
        this.tabsEl = document.createElement("div");
        this.tabsEl.className = "prompt-collection-tabs";
        this.append(this.promptsEl, this.tabsEl);

        // Live reordering while dragging a tab across the tab zone.
        this.tabsEl.addEventListener("dragover", (e) => this.onDragOver(e));
        this.tabsEl.addEventListener("drop", (e) => e.preventDefault());
    }

    // ── Prompts ───────────────────────────────────────────────────────────────

    /** The prompt entries, in tab order. */
    get prompts(): Entry[] {
        this.ensureSetup();
        return [...this.order];
    }

    /** The active prompt's entry, or null if empty. */
    get activePrompt(): Entry | null {
        this.ensureSetup();
        return this.active;
    }

    /** Add a prompt (and its tab) for `entry`. The first prompt added becomes
     *  active. Returns the same Entry (the prompt's handle). */
    addPrompt(entry: Entry): Entry {
        this.ensureSetup();
        if (this.rows.has(entry)) {
            return entry;
        }
        const id = `p${++this.seq}`;

        const marker = document.createElement("div");
        marker.className = "prompt-collection-marker";

        const content: StyledText = entry.prompt?.content ?? { text: "", ranges: [] };

        const editorHost = document.createElement("div");
        editorHost.className = "prompt-collection-editor";
        const editor = this.editorFactory({
            doc: content.text,
            // Keep the Entry's Prompt content text in sync with the editor.
            onChange: (value) => {
                if (entry.prompt) {
                    entry.prompt.content.text = value;
                }
            },
            onNavigate: (dir) => this.rotate(dir),
        });
        editorHost.appendChild(editor.dom);

        const row = document.createElement("div");
        row.className = "prompt-collection-prompt";
        row.setAttribute("data-prompt", id);
        row.hidden = true;
        row.append(marker, editorHost);
        // Heed the Entry's key bindings. Capture phase so a bound chord fires the
        // "command" event before the editor (CodeMirror) can act on the key.
        row.addEventListener("keydown", (e) => this.handleBindings(entry, e), true);
        this.promptsEl.appendChild(row);

        const tab = document.createElement("span");
        tab.className = "prompt-collection-tab";
        tab.setAttribute("data-prompt", id);
        tab.textContent = entry.echo.label;
        tab.draggable = true;
        tab.addEventListener("click", () => this.showPrompt(entry));
        tab.addEventListener("dragstart", (e) => {
            this.dragEntry = entry;
            tab.classList.add("dragging");
            e.dataTransfer?.setData("text/plain", id);
            if (e.dataTransfer) {
                e.dataTransfer.effectAllowed = "move";
            }
        });
        tab.addEventListener("dragend", () => {
            tab.classList.remove("dragging");
            this.dragEntry = null;
            this.syncOrderFromDom();
        });
        this.tabsEl.appendChild(tab);

        // Re-read the prompt whenever the Entry is reconfigured (entry.fire()).
        const listener = (): void => this.reconfigure(entry);
        entry.listeners.push(listener);

        const rowEntry: Row = { entry, id, row, marker, tab, editor, listener };
        this.rows.set(entry, rowEntry);
        this.byId.set(id, entry);
        this.order.push(entry);

        // Render the leading marker and apply the initial styled content.
        this.renderMarker(marker, entry.prompt?.prompt);
        this.applyContent(editor, content);

        // Paint the tab (grey while inactive); activation restyles the active one.
        this.applyTabStyle(rowEntry);
        if (this.active === null) {
            this.activate(entry, false);
        }
        return entry;
    }

    /** Remove a prompt; if it was active, the next prompt becomes active. */
    removePrompt(entry: Entry): void {
        this.ensureSetup();
        const row = this.rows.get(entry);
        if (!row) {
            return;
        }
        entry.listeners = entry.listeners.filter((l) => l !== row.listener);
        row.editor.destroy();
        row.row.remove();
        row.tab.remove();
        this.rows.delete(entry);
        this.byId.delete(row.id);
        this.order = this.order.filter((x) => x !== entry);
        if (this.active === entry) {
            this.active = null;
            if (this.order.length > 0) {
                this.activate(this.order[0], false);
            }
        }
    }

    /** Switch to a prompt and focus its editor. No-op for an unknown entry. */
    showPrompt(entry: Entry): void {
        this.activate(entry, true);
    }

    private activate(entry: Entry, focus: boolean): void {
        this.ensureSetup();
        if (!this.rows.has(entry)) {
            return;
        }
        this.active = entry;
        for (const [e, row] of this.rows) {
            const on = e === entry;
            row.row.hidden = !on;
            row.tab.classList.toggle("active", on);
            row.tab.setAttribute("aria-selected", String(on));
            // Active tab wears its accent; inactive tabs go grey.
            this.applyTabStyle(row);
        }
        if (focus) {
            this.rows.get(entry)?.editor.focus();
        }
        this.dispatchEvent(
            new CustomEvent<PromptChangeDetail>("promptchange", {
                detail: { entry },
                bubbles: true,
            }),
        );
    }

    // Match a keydown against the Entry's `bindings` map. On a match, swallow the
    // key (so the editor doesn't also act on it) and fire a bubbling "command"
    // event carrying the command name, the keyboard event and the Entry.
    private handleBindings(entry: Entry, e: KeyboardEvent): void {
        const bindings = entry.prompt?.bindings;
        if (!bindings) {
            return;
        }
        const chord = chordFromEvent(e);
        for (const [key, command] of Object.entries(bindings)) {
            if (normalizeChord(key) === chord) {
                e.preventDefault();
                e.stopPropagation();
                const editor = this.rows.get(entry)?.editor;
                const text = editor?.getValue() ?? "";
                const position = editor?.getPosition?.() ?? text.length;
                this.dispatchEvent(
                    new CustomEvent<PromptCommandDetail>("command", {
                        detail: { command, event: e, entry, text, position },
                        bubbles: true,
                    }),
                );
                return;
            }
        }
    }

    /** Rotate the active prompt cyclically (-1 = previous, +1 = next) and focus
     *  it. Bound to Cmd/Ctrl-Left / Cmd/Ctrl-Right in the CodeMirror editor. */
    private rotate(direction: -1 | 1): void {
        if (this.order.length < 2 || this.active === null) {
            return;
        }
        const cur = this.order.indexOf(this.active);
        if (cur < 0) {
            return;
        }
        const n = this.order.length;
        const next = (cur + direction + n) % n;
        this.showPrompt(this.order[next]);
    }

    /** Move a prompt to a new index in the tab order. */
    movePrompt(entry: Entry, toIndex: number): void {
        this.ensureSetup();
        const from = this.order.indexOf(entry);
        if (from < 0) {
            return;
        }
        this.order.splice(from, 1);
        const idx = Math.max(0, Math.min(this.order.length, toIndex));
        this.order.splice(idx, 0, entry);
        this.applyOrder();
        this.dispatchEvent(
            new CustomEvent<PromptReorderDetail>("reorder", {
                detail: { order: [...this.order] },
                bubbles: true,
            }),
        );
    }

    // ── Reconfiguration ─────────────────────────────────────────────────────

    // Re-read an Entry's label, accent and marker after its Echo was reconfigured.
    // The editor content is left untouched so live edits are never clobbered.
    private reconfigure(entry: Entry): void {
        const row = this.rows.get(entry);
        if (!row) {
            return;
        }
        row.tab.textContent = entry.echo.label;
        this.renderMarker(row.marker, entry.prompt?.prompt);
        this.applyTabStyle(row);
    }

    /** Paint a tab from its Echo accent while active, or grey while inactive. The
     *  accent is resolved through the color grammar; an unparseable one is
     *  ignored (the tab falls back to inherited styling). */
    private applyTabStyle(row: Row): void {
        const accent = row.entry === this.active ? row.entry.echo.color : "grey";
        let css = "";
        if (accent) {
            try {
                css = styleToCss(this.theme.calculateStyle(accent));
            } catch {
                css = "";
            }
        }
        row.tab.setAttribute("style", css);
    }

    // ── Editor access ─────────────────────────────────────────────────────────

    getEditor(entry: Entry): PromptEditor | null {
        this.ensureSetup();
        return this.rows.get(entry)?.editor ?? null;
    }

    getValue(entry: Entry): string {
        this.ensureSetup();
        return this.rows.get(entry)?.editor.getValue() ?? "";
    }

    /**
     * Set a prompt's editor value. A plain string sets just the text. A
     * {@link StyledText} additionally colorizes the text (resolving each range's
     * accent through {@link calculateStyle}) and, when a `position` is given,
     * moves the cursor there.
     */
    setValue(entry: Entry, value: string | StyledText): void {
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

    // Apply a StyledText's colorization and cursor position to an editor.
    private applyContent(editor: PromptEditor, content: StyledText): void {
        const { base, spans } = this.resolveContent(content.ranges ?? [], content.text);
        editor.setBaseStyle?.(base);
        editor.setHighlights?.(spans);
        if (content.position != null) {
            editor.setPosition?.(content.position);
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

    // Render a StyledText leading marker into `marker` (empty when absent).
    private renderMarker(marker: HTMLElement, styled: StyledText | undefined): void {
        if (styled?.text) {
            marker.replaceChildren(buildStyledText(styled, this.theme));
        } else {
            marker.replaceChildren();
        }
    }

    // Re-append tabs and rows to match `this.order`.
    private applyOrder(): void {
        for (const entry of this.order) {
            const row = this.rows.get(entry);
            if (row) {
                this.tabsEl.appendChild(row.tab);
                this.promptsEl.appendChild(row.row);
            }
        }
    }

    // While dragging, move the dragged tab to the pointer's position.
    private onDragOver(e: DragEvent): void {
        if (!this.dragEntry) {
            return;
        }
        e.preventDefault();
        const dragging = this.rows.get(this.dragEntry)?.tab;
        if (!dragging) {
            return;
        }
        const others = Array.from(
            this.tabsEl.querySelectorAll<HTMLElement>(".prompt-collection-tab:not(.dragging)"),
        );
        const after = others.find((t) => {
            const r = t.getBoundingClientRect();
            return e.clientX < r.left + r.width / 2;
        });
        if (after) {
            this.tabsEl.insertBefore(dragging, after);
        } else {
            this.tabsEl.appendChild(dragging);
        }
    }

    // After a drag ends, adopt the DOM tab order as the canonical order.
    private syncOrderFromDom(): void {
        const domIds = Array.from(this.tabsEl.children)
            .map((c) => c.getAttribute("data-prompt"))
            .filter((x): x is string => x != null);
        const domOrder = domIds
            .map((id) => this.byId.get(id))
            .filter((e): e is Entry => e != null);
        const prevIds = this.order.map((e) => this.rows.get(e)?.id ?? "");
        const changed = domIds.join(" ") !== prevIds.join(" ");
        this.order = domOrder;
        for (const entry of this.order) {
            const row = this.rows.get(entry);
            if (row) {
                this.promptsEl.appendChild(row.row);
            }
        }
        if (changed) {
            this.dispatchEvent(
                new CustomEvent<PromptReorderDetail>("reorder", {
                    detail: { order: [...this.order] },
                    bubbles: true,
                }),
            );
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
