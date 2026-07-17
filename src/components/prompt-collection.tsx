// A collection of prompts as a custom element: `<prompt-collection>`.
//
//   const pc = document.createElement("prompt-collection") as PromptCollection;
//   pc.addPrompt({ label: "sh", color: "#8ae234", promptHtml: "<b>$</b>", doc: "" });
//   pc.addPrompt({ label: "py", color: "#729fcf", promptHtml: "<b>&gt;&gt;&gt;</b>" });
//   container.appendChild(pc);
//
// Each prompt is a CodeMirror input box with some prompt HTML to its left (its
// leading marker). Only the active prompt is shown. Under the prompt is a tab
// zone: one tab per prompt, which is simply its label — the only styling is the
// label's colour (configurable per prompt). Click a label to switch prompts;
// drag labels to reorder them.
//
//   ┌───────────────────────────────────────────┐
//   │ $  │ the active prompt's CodeMirror editor  │
//   ├───────────────────────────────────────────┤
//   │ sh   py   notes            ← tab zone       │
//   └───────────────────────────────────────────┘
//
// This is intentionally standalone (it does not import the `Prompt` class), but
// its config mirrors PromptConfiguration (label / color / prompt_html / text) so
// it can be wired to real prompts later. The editor is created through a swappable
// `editorFactory` (default: CodeMirror) so alternative editors can be injected.
//
// Events (both bubble):
//   "promptchange"  detail: { prompt: string }      — the active prompt changed
//   "reorder"       detail: { order: string[] }      — tabs were reordered
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
import type { Accent, HighlightRange, StyledText } from "../types.ts";

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
}

export type EditorFactory = (options: {
    doc: string;
    onChange?: (value: string) => void;
    /** Invoked when the user asks to rotate focus (-1 = previous, +1 = next). */
    onNavigate?: (direction: -1 | 1) => void;
}) => PromptEditor;

export interface PromptSpec {
    /** Stable id; generated if omitted. */
    id?: string;
    /** Tab label. */
    label: string;
    /**
     * Tab label accent — a color/style description resolved through
     * {@link calculateStyle} (see `color.ts`). Applied while the tab is active;
     * inactive tabs are shown grey.
     */
    color?: Accent;
    /** HTML (or a node) for the leading marker shown left of the editor. */
    promptHtml?: string | Node;
    /** Initial editor text. */
    doc?: string;
    /** Called with the new value whenever the editor's text changes. */
    onChange?: (value: string) => void;
}

interface Entry {
    id: string;
    label: string;
    color?: string;
    row: HTMLElement; // [marker][editor]
    marker: HTMLElement;
    tab: HTMLElement;
    editor: PromptEditor;
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
    private entries = new Map<string, Entry>();
    private order: string[] = [];
    private active: string | null = null;
    private seq = 0;
    private dragId: string | null = null;

    connectedCallback(): void {
        this.ensureSetup();
    }

    private ensureSetup(): void {
        if (this.initialized) {
            return;
        }
        this.initialized = true;

        // Capture authored `[data-label]` children as prompts (their innerHTML
        // becomes the leading marker), then rebuild.
        const authored = Array.from(this.children).filter(
            (c): c is HTMLElement => c instanceof HTMLElement && c.hasAttribute("data-label"),
        );
        this.replaceChildren();

        this.promptsEl = document.createElement("div");
        this.promptsEl.className = "prompt-collection-prompts";
        this.tabsEl = document.createElement("div");
        this.tabsEl.className = "prompt-collection-tabs";
        this.append(this.promptsEl, this.tabsEl);

        // Live reordering while dragging a tab across the tab zone.
        this.tabsEl.addEventListener("dragover", (e) => this.onDragOver(e));
        this.tabsEl.addEventListener("drop", (e) => e.preventDefault());

        for (const child of authored) {
            this.addPrompt({
                label: child.getAttribute("data-label") ?? "",
                color: child.getAttribute("data-color") ?? undefined,
                promptHtml: child.innerHTML,
                doc: child.getAttribute("data-doc") ?? "",
            });
        }
    }

    // ── Prompts ───────────────────────────────────────────────────────────────

    /** The prompt ids, in tab order. */
    get prompts(): string[] {
        this.ensureSetup();
        return [...this.order];
    }

    /** The active prompt id, or null if empty. */
    get activePrompt(): string | null {
        this.ensureSetup();
        return this.active;
    }

    /** Add a prompt (and its tab). The first prompt added becomes active.
     *  Returns the prompt id. */
    addPrompt(spec: PromptSpec): string {
        this.ensureSetup();
        const id = spec.id ?? `p${++this.seq}`;
        if (this.entries.has(id)) {
            throw new Error(`prompt-collection: duplicate prompt id "${id}"`);
        }

        const marker = document.createElement("div");
        marker.className = "prompt-collection-marker";
        this.setMarker(marker, spec.promptHtml);

        const editorHost = document.createElement("div");
        editorHost.className = "prompt-collection-editor";
        const editor = this.editorFactory({
            doc: spec.doc ?? "",
            onChange: spec.onChange,
            onNavigate: (dir) => this.rotate(dir),
        });
        editorHost.appendChild(editor.dom);

        const row = document.createElement("div");
        row.className = "prompt-collection-prompt";
        row.setAttribute("data-prompt", id);
        row.hidden = true;
        row.append(marker, editorHost);
        this.promptsEl.appendChild(row);

        const tab = document.createElement("span");
        tab.className = "prompt-collection-tab";
        tab.setAttribute("data-prompt", id);
        tab.textContent = spec.label;
        tab.draggable = true;
        tab.addEventListener("click", () => this.showPrompt(id));
        tab.addEventListener("dragstart", (e) => {
            this.dragId = id;
            tab.classList.add("dragging");
            e.dataTransfer?.setData("text/plain", id);
            if (e.dataTransfer) {
                e.dataTransfer.effectAllowed = "move";
            }
        });
        tab.addEventListener("dragend", () => {
            tab.classList.remove("dragging");
            this.dragId = null;
            this.syncOrderFromDom();
        });
        this.tabsEl.appendChild(tab);

        const entry: Entry = {
            id,
            label: spec.label,
            color: spec.color,
            row,
            marker,
            tab,
            editor,
        };
        this.entries.set(id, entry);
        this.order.push(id);
        // Paint the tab (grey while inactive); activation restyles the active one.
        this.applyTabStyle(entry);
        if (this.active === null) {
            this.activate(id, false);
        }
        return id;
    }

    /** Remove a prompt; if it was active, the next prompt becomes active. */
    removePrompt(id: string): void {
        this.ensureSetup();
        const entry = this.entries.get(id);
        if (!entry) {
            return;
        }
        entry.editor.destroy();
        entry.row.remove();
        entry.tab.remove();
        this.entries.delete(id);
        this.order = this.order.filter((x) => x !== id);
        if (this.active === id) {
            this.active = null;
            if (this.order.length > 0) {
                this.activate(this.order[0], false);
            }
        }
    }

    /** Switch to a prompt by id and focus its editor. No-op for an unknown id. */
    showPrompt(id: string): void {
        this.activate(id, true);
    }

    private activate(id: string, focus: boolean): void {
        this.ensureSetup();
        if (!this.entries.has(id)) {
            return;
        }
        this.active = id;
        for (const [pid, entry] of this.entries) {
            const on = pid === id;
            entry.row.hidden = !on;
            entry.tab.classList.toggle("active", on);
            entry.tab.setAttribute("aria-selected", String(on));
            // Active tab wears its accent; inactive tabs go grey.
            this.applyTabStyle(entry);
        }
        if (focus) {
            this.entries.get(id)?.editor.focus();
        }
        this.dispatchEvent(
            new CustomEvent("promptchange", { detail: { prompt: id }, bubbles: true }),
        );
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
    movePrompt(id: string, toIndex: number): void {
        this.ensureSetup();
        const from = this.order.indexOf(id);
        if (from < 0) {
            return;
        }
        this.order.splice(from, 1);
        const idx = Math.max(0, Math.min(this.order.length, toIndex));
        this.order.splice(idx, 0, id);
        this.applyOrder();
        this.dispatchEvent(
            new CustomEvent("reorder", { detail: { order: [...this.order] }, bubbles: true }),
        );
    }

    // ── Per-prompt config ───────────────────────────────────────────────────

    setLabel(id: string, label: string): void {
        this.ensureSetup();
        const entry = this.entries.get(id);
        if (entry) {
            entry.label = label;
            entry.tab.textContent = label;
        }
    }

    /** Set a tab's accent (a color/style description; see `color.ts`). */
    setColor(id: string, color: Accent): void {
        this.ensureSetup();
        const entry = this.entries.get(id);
        if (entry) {
            entry.color = color;
            this.applyTabStyle(entry);
        }
    }

    /** Paint a tab from its accent while active, or grey while inactive. The
     *  accent is resolved through the color grammar; an unparseable one is
     *  ignored (the tab falls back to inherited styling). */
    private applyTabStyle(entry: Entry): void {
        const accent = entry.id === this.active ? entry.color : "grey";
        let css = "";
        if (accent) {
            try {
                css = styleToCss(this.theme.calculateStyle(accent));
            } catch {
                css = "";
            }
        }
        entry.tab.setAttribute("style", css);
    }

    setPromptHtml(id: string, html: string | Node): void {
        this.ensureSetup();
        const entry = this.entries.get(id);
        if (entry) {
            this.setMarker(entry.marker, html);
        }
    }

    // ── Editor access ─────────────────────────────────────────────────────────

    getEditor(id: string): PromptEditor | null {
        this.ensureSetup();
        return this.entries.get(id)?.editor ?? null;
    }

    getValue(id: string): string {
        this.ensureSetup();
        return this.entries.get(id)?.editor.getValue() ?? "";
    }

    /**
     * Set a prompt's value. A plain string sets just the text. A {@link StyledText}
     * additionally colorizes the text (resolving each range's accent through
     * {@link calculateStyle} against {@link anchors}) and, when a `position` is
     * given, moves the cursor there.
     */
    setValue(id: string, value: string | StyledText): void {
        this.ensureSetup();
        const entry = this.entries.get(id);
        if (!entry) {
            return;
        }
        if (typeof value === "string") {
            entry.editor.setValue(value);
            return;
        }
        const { base, spans } = this.resolveContent(value.ranges ?? [], value.text);
        entry.editor.setValue(value.text);
        entry.editor.setBaseStyle?.(base);
        entry.editor.setHighlights?.(spans);
        if (value.position != null) {
            entry.editor.setPosition?.(value.position);
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

    private setMarker(marker: HTMLElement, html: string | Node | undefined): void {
        if (html == null) {
            marker.replaceChildren();
        } else if (typeof html === "string") {
            marker.innerHTML = html;
        } else {
            marker.replaceChildren(html);
        }
    }

    // Re-append tabs and rows to match `this.order`.
    private applyOrder(): void {
        for (const id of this.order) {
            const entry = this.entries.get(id);
            if (entry) {
                this.tabsEl.appendChild(entry.tab);
                this.promptsEl.appendChild(entry.row);
            }
        }
    }

    // While dragging, move the dragged tab to the pointer's position.
    private onDragOver(e: DragEvent): void {
        if (!this.dragId) {
            return;
        }
        e.preventDefault();
        const dragging = this.entries.get(this.dragId)?.tab;
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
        const domOrder = Array.from(this.tabsEl.children)
            .map((c) => c.getAttribute("data-prompt"))
            .filter((x): x is string => x != null);
        const changed = domOrder.join(" ") !== this.order.join(" ");
        this.order = domOrder;
        for (const id of this.order) {
            const entry = this.entries.get(id);
            if (entry) {
                this.promptsEl.appendChild(entry.row);
            }
        }
        if (changed) {
            this.dispatchEvent(
                new CustomEvent("reorder", { detail: { order: [...this.order] }, bubbles: true }),
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
