// An ANSI text renderer as a custom element: `<basic-ansi>`.
//
//   const view = document.createElement("basic-ansi") as BasicAnsi;
//   container.appendChild(view);
//   view.write("\x1b[32mhello\x1b[0m world\n");   // feed raw pty output
//
// It accepts raw terminal output (ANSI SGR colours/styles, \r, \b, \t, \n and a
// handful of CSI cursor/erase sequences) and renders it as styled <span>s inside
// a <pre>, with a blinking cursor at the write position. It is deliberately
// "basic": a scrolling text view, not a screen-addressable emulator — unhandled
// sequences (full cursor positioning, alternate screen) are ignored.
//
// It tracks how much it holds (lineCount / byteLength) and can drop content from
// the front with prune() — the building blocks the windowing <basic-term> uses to
// keep only the first N and last M lines. The ANSI core (`TermBuffer`) is ported
// from ~/code/buche's src/terminal/ansi.js.
//
// Appearance lives in the companion stylesheet `basic-ansi.css` (or the
// consolidated components.css).

import type { DomProps } from "myjsx/jsx-runtime";

// ── ANSI core (ported from ~/code/buche/src/terminal/ansi.js) ──

// Standard 16 ANSI colours.
const C16 = [
    "#1c1c1c",
    "#cc0000",
    "#4e9a06",
    "#c4a000",
    "#3465a4",
    "#75507b",
    "#06989a",
    "#d3d7cf",
    "#555753",
    "#ef2929",
    "#8ae234",
    "#fce94f",
    "#729fcf",
    "#ad7fa8",
    "#34e2e2",
    "#eeeeec",
];

// Map an xterm 256-colour index to a CSS colour.
function c256(n: number): string {
    if (n < 16) {
        return C16[n];
    }
    if (n >= 232) {
        const v = Math.round(((n - 232) * 255) / 23);
        return `rgb(${v},${v},${v})`;
    }
    const i = n - 16;
    const r = Math.floor(i / 36);
    const g = Math.floor(i / 6) % 6;
    const b = i % 6;
    const x = (v: number) => (v ? v * 40 + 55 : 0);
    return `rgb(${x(r)},${x(g)},${x(b)})`;
}

// A trailing, not-yet-complete escape sequence at the end of a chunk.
// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC (\x1b) is the intended ANSI escape byte
const INCOMPLETE_RE = /\x1b(?:\[[0-9;]*)?$/;

// One rendered character plus the style/stream it was written with.
interface Cell {
    char: string;
    fg: string | null;
    bg: string | null;
    bold: boolean;
    italic: boolean;
    underline: boolean;
    stream: string;
}

// A completed line as a rendered <span> plus its length in characters, or a
// `{ clear: true }` marker asking the consumer to wipe the view (\x1b[2J/[3J).
export type WrittenLine = { node: HTMLSpanElement; bytes: number } | { clear: true };

function makeSpan(
    text: string,
    streamClass: string,
    fg: string | null,
    bg: string | null,
    bold: boolean,
    italic: boolean,
    underline: boolean,
): HTMLSpanElement {
    const span = document.createElement("span");
    span.className = `text-${streamClass}`;
    let style = "";
    if (fg) {
        style += `color:${fg};`;
    }
    if (bg) {
        style += `background:${bg};`;
    }
    if (bold) {
        style += "font-weight:bold;";
    }
    if (italic) {
        style += "font-style:italic;";
    }
    if (underline) {
        style += "text-decoration:underline;";
    }
    if (style) {
        span.style.cssText = style;
    }
    span.textContent = text;
    return span;
}

function stylesEq(a: Cell, b: Cell): boolean {
    return (
        a.fg === b.fg &&
        a.bg === b.bg &&
        a.bold === b.bold &&
        a.italic === b.italic &&
        a.underline === b.underline &&
        a.stream === b.stream
    );
}

// Processes raw terminal output into DOM nodes. Handles \b (backspace),
// \r (carriage return), \n (linefeed), \t (tab), ANSI SGR (colours/styles),
// and a subset of CSI cursor/erase sequences.
export class TermBuffer {
    // CSI command letters that `handleCSI` actively processes.
    static HANDLED_CSI = new Set(["m", "K", "A", "C", "D", "J", "H"]);

    // True if `text` contains a CSI sequence whose command letter is not in
    // HANDLED_CSI — i.e. something this text view cannot render correctly.
    static containsUnhandledEscape(text: string): boolean {
        // biome-ignore lint/suspicious/noControlCharactersInRegex: ESC (\x1b) is the intended ANSI escape byte
        const CSI_RE = /\x1b\[([0-9;?]*)([A-Za-z~])/g;
        let m: RegExpExecArray | null;
        while ((m = CSI_RE.exec(text)) !== null) {
            if (!TermBuffer.HANDLED_CSI.has(m[2])) {
                return true;
            }
        }
        return false;
    }

    // Cap on the current line's length in cells; extra characters are dropped so
    // a single newline-less line (e.g. 1 MB of output) can't grow without bound.
    maxCells = Number.POSITIVE_INFINITY;

    private fg: string | null = null;
    private bg: string | null = null;
    private bold = false;
    private italic = false;
    private underline = false;
    private esc = ""; // pending incomplete escape sequence
    private cells: Cell[] = []; // current line
    private col = 0; // cursor column
    private cursorUpDebt = 0; // pending cursor-up moves not yet offset by \n
    private clearRequested = false;

    // Length in characters of the current (partial) line.
    get currentCellCount(): number {
        return this.cells.length;
    }

    resetStyle(): void {
        this.fg = null;
        this.bg = null;
        this.bold = false;
        this.italic = false;
        this.underline = false;
    }

    // Apply one SGR code (at index `i` of `codes`); returns how many extra
    // codes were consumed (for 38/48 extended-colour sequences).
    private apply(codes: number[], i: number): number {
        const c = codes[i];
        if (c === 0) {
            this.fg = this.bg = null;
            this.bold = this.italic = this.underline = false;
        } else if (c === 1) {
            this.bold = true;
        } else if (c === 3) {
            this.italic = true;
        } else if (c === 4) {
            this.underline = true;
        } else if (c === 22) {
            this.bold = false;
        } else if (c === 23) {
            this.italic = false;
        } else if (c === 24) {
            this.underline = false;
        } else if (c >= 30 && c <= 37) {
            this.fg = C16[c - 30];
        } else if (c === 38 && codes[i + 1] === 5) {
            this.fg = c256(codes[i + 2]);
            return 2;
        } else if (c === 38 && codes[i + 1] === 2) {
            this.fg = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`;
            return 4;
        } else if (c === 39) {
            this.fg = null;
        } else if (c >= 40 && c <= 47) {
            this.bg = C16[c - 40];
        } else if (c === 48 && codes[i + 1] === 5) {
            this.bg = c256(codes[i + 2]);
            return 2;
        } else if (c === 48 && codes[i + 1] === 2) {
            this.bg = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`;
            return 4;
        } else if (c === 49) {
            this.bg = null;
        } else if (c >= 90 && c <= 97) {
            this.fg = C16[c - 90 + 8];
        } else if (c >= 100 && c <= 107) {
            this.bg = C16[c - 100 + 8];
        }
        return 0;
    }

    private put(ch: string, stream: string): void {
        // Drop characters past the per-line cap (keeps giant lines bounded).
        if (this.col >= this.maxCells) {
            return;
        }
        const cell: Cell = {
            char: ch,
            fg: this.fg,
            bg: this.bg,
            bold: this.bold,
            italic: this.italic,
            underline: this.underline,
            stream,
        };
        if (this.col < this.cells.length) {
            this.cells[this.col] = cell;
        } else {
            while (this.cells.length < this.col) {
                this.cells.push({
                    char: " ",
                    fg: null,
                    bg: null,
                    bold: false,
                    italic: false,
                    underline: false,
                    stream,
                });
            }
            this.cells.push(cell);
        }
        this.col++;
    }

    // Convert a slice of cells to a DocumentFragment of styled spans, coalescing
    // runs of equal style into a single span.
    private cellsToFrag(start = 0, end = this.cells.length): DocumentFragment {
        const frag = document.createDocumentFragment();
        const cells = this.cells;
        let i = start;
        while (i < end) {
            const c0 = cells[i];
            let j = i + 1;
            while (j < end && stylesEq(cells[j], c0)) {
                j++;
            }
            const text = cells
                .slice(i, j)
                .map((c) => c.char)
                .join("");
            frag.appendChild(
                makeSpan(text, c0.stream, c0.fg, c0.bg, c0.bold, c0.italic, c0.underline),
            );
            i = j;
        }
        return frag;
    }

    // A <span> wrapping the current partial line (non-destructive). If `cursorEl`
    // is given it is inserted at the cursor column. Returns null for an empty line.
    currentLineNode(cursorEl: Node | null = null): HTMLSpanElement | null {
        if (this.cells.length === 0) {
            return null;
        }
        const span = document.createElement("span");
        const col = this.col;
        if (col > 0) {
            span.appendChild(this.cellsToFrag(0, col));
        }
        if (cursorEl) {
            span.appendChild(cursorEl);
        }
        if (col < this.cells.length) {
            span.appendChild(this.cellsToFrag(col, this.cells.length));
        }
        return span;
    }

    private handleCSI(params: string, cmd: string): void {
        if (cmd === "m") {
            const codes = params === "" ? [0] : params.split(";").map(Number);
            for (let i = 0; i < codes.length; i++) {
                i += this.apply(codes, i);
            }
        } else if (cmd === "K") {
            const n = parseInt(params, 10) || 0;
            if (n === 0) {
                this.cells.splice(this.col); // erase cursor→EOL
            } else if (n === 1) {
                this.cells.splice(0, this.col); // erase BOL→cursor
                this.col = 0;
            } else if (n === 2) {
                this.cells = []; // erase entire line
                this.col = 0;
            }
        } else if (cmd === "A") {
            this.cursorUpDebt += parseInt(params, 10) || 1;
        } else if (cmd === "C") {
            this.col = Math.min(this.cells.length, this.col + (parseInt(params, 10) || 1));
        } else if (cmd === "D") {
            this.col = Math.max(0, this.col - (parseInt(params, 10) || 1));
        } else if (cmd === "J") {
            this.clearRequested = true;
            this.cells = [];
            this.col = 0;
        }
        // H (cursor position) and other sequences are no-ops in text mode.
    }

    // Process raw terminal text. Returns completed lines and `{ clear: true }`
    // markers. The current partial line is not returned — call currentLineNode().
    write(text: string, streamClass = "stdout"): WrittenLine[] {
        const input = this.esc + text;
        this.esc = "";

        // Hold back any trailing incomplete escape sequence for the next chunk.
        const tail = INCOMPLETE_RE.exec(input);
        const src = tail ? input.slice(0, tail.index) : input;
        if (tail) {
            this.esc = tail[0];
        }

        const lines: WrittenLine[] = [];
        let i = 0;

        while (i < src.length) {
            const ch = src[i];

            if (ch === "\x1b" && src[i + 1] === "[") {
                // biome-ignore lint/suspicious/noControlCharactersInRegex: ESC (\x1b) is the intended ANSI escape byte
                const m = /^\x1b\[([0-9;?]*)([A-Za-z~])/.exec(src.slice(i));
                if (m) {
                    this.handleCSI(m[1], m[2]);
                    if (this.clearRequested) {
                        this.clearRequested = false;
                        lines.push({ clear: true });
                    }
                    i += m[0].length;
                } else {
                    i++;
                }
            } else if (ch === "\x1b") {
                i += src[i + 1] ? 2 : 1; // skip 2-char escape (e.g. \x1b= \x1b>)
            } else if (ch === "\r") {
                this.col = 0;
                i++;
            } else if (ch === "\n") {
                if (this.cursorUpDebt > 0 && this.cells.length === 0) {
                    this.cursorUpDebt--;
                    i++;
                } else {
                    this.cursorUpDebt = 0;
                    const line = document.createElement("span");
                    line.appendChild(this.cellsToFrag());
                    line.appendChild(document.createTextNode("\n"));
                    lines.push({ node: line, bytes: this.cells.length });
                    this.cells = [];
                    this.col = 0;
                    i++;
                }
            } else if (ch === "\b") {
                if (this.col > 0) {
                    this.col--;
                }
                i++;
            } else if (ch === "\t") {
                const next = (Math.floor(this.col / 8) + 1) * 8;
                while (this.col < next) {
                    this.put(" ", streamClass);
                }
                i++;
            } else if (ch >= " ") {
                this.put(ch, streamClass);
                i++;
            } else {
                i++; // skip other C0 controls
            }
        }

        return lines;
    }
}

// ── The custom element ──

type CursorState = "active" | "inactive" | "hidden";

// A completed-line <span> carries its character length so prune() can account
// for dropped bytes without re-measuring the DOM.
type LineSpan = HTMLSpanElement & { _bytes?: number };

export class BasicAnsi extends HTMLElement {
    private buffer = new TermBuffer();
    private initialized = false;
    // <pre> holding completed line spans followed by the current partial line.
    private linesEl!: HTMLPreElement;
    // The current partial-line element (removed and rebuilt on every write).
    private currentEl: HTMLElement | null = null;
    private cursorEl!: HTMLSpanElement;
    private cursorEnabled = true;
    private completedLines = 0;
    private completedBytes = 0;

    connectedCallback(): void {
        this.ensureSetup();
    }

    private ensureSetup(): void {
        if (this.initialized) {
            return;
        }
        this.initialized = true;

        this.linesEl = document.createElement("pre");
        this.linesEl.className = "basic-ansi-lines";

        this.cursorEl = document.createElement("span");
        this.cursorEl.className = "cursor cursor-active";

        this.appendChild(this.linesEl);
        this.renderCursor();
    }

    /** Number of completed (newline-terminated) lines currently held. */
    get lineCount(): number {
        this.ensureSetup();
        return this.completedLines;
    }

    /** Total rendered length in characters, including the current partial line. */
    get byteLength(): number {
        this.ensureSetup();
        return this.completedBytes + this.buffer.currentCellCount;
    }

    /** Cap the current line's length so a giant newline-less line stays bounded. */
    set maxLineBytes(n: number) {
        this.buffer.maxCells = n > 0 ? n : Number.POSITIVE_INFINITY;
    }

    /** Feed a chunk of raw terminal output. Returns whether it cleared the view. */
    write(text: string, stream = "stdout"): { cleared: boolean } {
        this.ensureSetup();
        this.detachCurrent();

        let cleared = false;
        for (const line of this.buffer.write(text, stream)) {
            if ("clear" in line) {
                this.clearContent();
                cleared = true;
            } else {
                (line.node as LineSpan)._bytes = line.bytes;
                this.linesEl.appendChild(line.node);
                this.completedLines++;
                this.completedBytes += line.bytes;
            }
        }
        this.renderCursor();
        return { cleared };
    }

    /**
     * Drop content from the front until the view holds at most `maxBytes`
     * characters and `maxLines` completed lines. Whole leading lines go first;
     * if a single remaining line is still too big, its leading characters are
     * trimmed. Never drops the current (partial) line. Returns what was dropped.
     */
    prune(
        maxBytes: number,
        maxLines = Number.POSITIVE_INFINITY,
    ): { lines: number; bytes: number } {
        this.ensureSetup();
        let lines = 0;
        let bytes = 0;

        while (
            (this.byteLength > maxBytes || this.completedLines > maxLines) &&
            this.linesEl.firstChild &&
            this.linesEl.firstChild !== this.currentEl
        ) {
            const el = this.linesEl.firstChild as LineSpan;
            const b = el._bytes ?? el.textContent?.length ?? 0;
            this.linesEl.removeChild(el);
            this.completedLines--;
            this.completedBytes -= b;
            lines++;
            bytes += b;
        }

        // A single leading line still over budget: trim its leading characters.
        if (
            this.byteLength > maxBytes &&
            this.linesEl.firstChild &&
            this.linesEl.firstChild !== this.currentEl
        ) {
            const el = this.linesEl.firstChild as LineSpan;
            const removed = trimLineFront(el, this.byteLength - maxBytes);
            el._bytes = (el._bytes ?? 0) - removed;
            this.completedBytes -= removed;
            bytes += removed;
        }

        return { lines, bytes };
    }

    /** Wipe all rendered content (as requested by \x1b[2J / \x1b[3J). */
    clear(): void {
        this.ensureSetup();
        this.detachCurrent();
        this.clearContent();
        this.renderCursor();
    }

    /** Show or hide the cursor entirely (e.g. once this region is frozen). */
    setCursorEnabled(on: boolean): void {
        this.ensureSetup();
        if (this.cursorEnabled === on) {
            return;
        }
        this.cursorEnabled = on;
        this.detachCurrent();
        this.renderCursor();
    }

    /** Set the cursor's visual state (active/inactive/hidden). */
    setCursorState(state: CursorState): void {
        this.ensureSetup();
        this.cursorEl.classList.remove("cursor-active", "cursor-inactive", "cursor-hidden");
        this.cursorEl.classList.add(`cursor-${state}`);
    }

    private clearContent(): void {
        this.linesEl.replaceChildren();
        this.completedLines = 0;
        this.completedBytes = 0;
        this.currentEl = null;
    }

    private detachCurrent(): void {
        this.cursorEl.remove();
        if (this.currentEl) {
            this.currentEl.remove();
            this.currentEl = null;
        }
    }

    // Re-attach the current partial line (with the cursor inside it, if enabled).
    private renderCursor(): void {
        const cursor = this.cursorEnabled ? this.cursorEl : null;
        const node = this.buffer.currentLineNode(cursor);
        if (node) {
            this.linesEl.appendChild(node);
            this.currentEl = node;
        } else if (cursor) {
            // Empty current line: still show the cursor at the start of it.
            const holder = document.createElement("span");
            holder.appendChild(cursor);
            this.linesEl.appendChild(holder);
            this.currentEl = holder;
        } else {
            this.currentEl = null;
        }
    }
}

// Remove up to `count` leading characters from a completed-line span, walking its
// styled child spans (leaving the trailing "\n" text node intact). Returns the
// number of characters actually removed.
function trimLineFront(lineEl: HTMLElement, count: number): number {
    let need = count;
    let removed = 0;
    let node = lineEl.firstChild;
    while (need > 0 && node) {
        const next = node.nextSibling;
        if (node.nodeType === Node.TEXT_NODE) {
            node = next; // skip the trailing "\n"
            continue;
        }
        const len = node.textContent?.length ?? 0;
        if (len <= need) {
            lineEl.removeChild(node);
            need -= len;
            removed += len;
        } else {
            node.textContent = (node.textContent as string).slice(need);
            removed += need;
            need = 0;
        }
        node = next;
    }
    return removed;
}

if (typeof customElements !== "undefined") {
    if (!customElements.get("basic-ansi")) {
        customElements.define("basic-ansi", BasicAnsi);
    }
}

declare module "myjsx/jsx-runtime" {
    namespace JSX {
        interface CustomElements {
            "basic-ansi": DomProps<BasicAnsi>;
        }
    }
}
