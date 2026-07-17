// An embedded terminal as a custom element: `<embedded-term>`.
//
//   <embedded-term max-rows="12"></embedded-term>
//   <embedded-term max-rows="12" no-fade></embedded-term>
//   <embedded-term max-rows="12" ed2-clears-scrollback></embedded-term>
//
//   const term = document.createElement("embedded-term") as EmbeddedTerm;
//   term.write("\x1b[32mhello\x1b[0m world\r\n");   // feed raw pty output
//   term.addEventListener("term-data", (e) => pty.write((e as CustomEvent<string>).detail));
//
// Events (both bubble): "term-data" carries keyboard input; "term-appear"
// announces that the terminal has been attached to the document.
//
// The terminal always declares `max-rows` rows to the pty, but the element only
// shows the rows that have ever been used — so it starts at height 0 and grows
// downward as output arrives. A row, once revealed, is never hidden again.
//
//   ┌ embedded-term ───────────┐  host is as tall as the revealed rows
//   │ ┌ clip ────────────────┐ │  overflow:hidden, height = revealed rows
//   │ │ fade-top             │ │  shown when scrolled off the top
//   │ │ .xterm  (max-rows)   │ │  always the full grid; the rest is clipped
//   │ │ fade-bottom          │ │  shown when not scrolled to the end
//   │ └──────────────────────┘ │
//   └───▁──────────────────────┘  the squashed cursor sits on the bottom edge
//
// Squashed cursor: when a chunk ends with a newline and writing it would spill
// onto a row that is not shown yet or scroll the screen, the newline is held
// rather than written, the real cursor is hidden, and a 4px sliver is drawn
// straddling the bottom edge in the terminal's cursor colour and on its blink
// cadence. It lives outside the clip, since overflow:hidden would otherwise eat
// its lower half. Holding the newline rather than testing the buffer for blank
// rows is what keeps the cursor working after a screenful of output, when every
// row is instantiated and nothing is blank.
//
// `fit(height)` leaves dynamic sizing: the row count becomes whatever fits
// `height` px, for real, and the pty is told about it. `fit(null)` goes back to
// growing dynamically.
//
// Config attributes (all optional):
//   max-rows  (default 10)   rows declared to the pty; the growth ceiling
//   cols      (default: fit) fixed column count instead of fitting the width
//   no-fade                  suppress the scroll edge gradients
//   ed2-clears-scrollback    make a bare clear-screen (Ctrl-L) drop the
//                            scrollback too, the way `clear(1)` does
//
// Requires `@xterm/xterm` and its stylesheet. Appearance lives in the companion
// stylesheet `embedded-term.css` (or the consolidated components.css).

import { Terminal } from "@xterm/xterm";
import type { DomProps } from "myjsx/jsx-runtime";

// Minimal shape of xterm's render dimensions. Declared here rather than
// imported: as of @xterm/xterm 6.0.0 neither `Terminal.dimensions` nor `_core`
// is in the public typings — `dimensions` exists only on newer builds — so the
// `_core._renderService` path in dims() is load-bearing, not a nicety. Property
// names survive the published build unmangled, so it resolves at runtime.
interface RenderDims {
    css: {
        cell: { width: number; height: number };
        canvas: { width: number; height: number };
    };
}

const SLIVER_HEIGHT = 4; // px; the squashed cursor
const FADE_ROWS = 1.5; // edge gradient height, in rows
const FADE_MIN = 16; // px floor for the gradient
const DEFAULT_MAX_ROWS = 10;

// Must match --embedded-term-bg in embedded-term.css, which colours the fades.
const THEME = { background: "#1c1c1c", foreground: "#d4d4d4", cursor: "#d4d4d4" };

export class EmbeddedTerm extends HTMLElement {
    static readonly observedAttributes = ["max-rows", "cols", "no-fade", "ed2-clears-scrollback"];

    private initialized = false;
    private term!: Terminal;
    private clip!: HTMLElement;
    private fadeTop!: HTMLElement;
    private fadeBottom!: HTMLElement;
    private stub!: HTMLElement;
    private observer: ResizeObserver | null = null;
    // Registered only while the ed2-clears-scrollback attribute is present, so
    // the CSI J identifier carries no extra handler when the feature is off.
    private clearHook: { dispose(): void } | null = null;

    private maxRows = DEFAULT_MAX_ROWS;
    // High-water mark of revealed rows. Never decreases while sizing is dynamic.
    private usedRows = 0;
    private inAlt = false;
    private stubOn = false;
    private stubKey = "";
    // null → dynamic sizing; a number → rows are pinned to fit that many px.
    private fixedHeight: number | null = null;
    // Dynamic-mode growth cap in px (the containing box's max-height);
    // null → fall back to the max-rows attribute.
    private boxHeight: number | null = null;

    // Held-newline state, see the block below.
    private held = ""; // a trailing "\n" not yet written, or ""
    private queue: (string | Uint8Array)[] = [];
    private writing = false;
    private cursorHidden = false;
    // When false, the real xterm cursor is kept hidden and the squashed cursor
    // is suppressed (see setCursorEnabled).
    private cursorEnabled = true;

    connectedCallback(): void {
        this.ensureSetup();
        this.observer ??= new ResizeObserver(() => this.refit());
        this.observer.observe(this);
        this.dispatchEvent(new CustomEvent("term-appear", { bubbles: true }));
    }

    disconnectedCallback(): void {
        // Keep the terminal alive so re-attaching the element just works.
        this.observer?.unobserve(this);
    }

    attributeChangedCallback(name: string): void {
        if (!this.initialized) {
            return; // ensureSetup reads every attribute itself
        }
        if (name === "no-fade") {
            this.apply();
        } else if (name === "max-rows") {
            this.maxRows = this.readMaxRows();
            if (this.fixedHeight === null) {
                this.resizeTerminal(this.dynamicRows());
            }
        } else if (name === "cols") {
            this.refit();
        } else if (name === "ed2-clears-scrollback") {
            this.syncClearHook();
        }
    }

    // ---------------------------------------------------------------- public

    /** The underlying xterm.js terminal, for addons and direct access. */
    get terminal(): Terminal {
        this.ensureSetup();
        return this.term;
    }

    /**
     * Feed a chunk of raw terminal output (ANSI sequences and all). Chunks are
     * queued and written in order; a trailing newline may be held back (see the
     * held-newline block). Write through this rather than `terminal.write`, or
     * the two orderings will interleave.
     */
    write(data: string | Uint8Array): void {
        this.ensureSetup();
        if (data.length > 0) {
            this.queue.push(data);
        }
        this.pump();
    }

    /** Clear the screen and the scrollback, leaving the cursor at home. */
    clear(): void {
        this.write("\x1b[H\x1b[2J\x1b[3J");
    }

    /**
     * Will the next character land at the start of a fresh line? A held newline
     * already supplies the break, so a caller that would otherwise prepend its
     * own `\r\n` must ask this instead of testing the cursor column, or it emits
     * one break too many and leaves a blank row behind.
     */
    get atLineStart(): boolean {
        this.ensureSetup();
        return this.term.buffer.active.cursorX === 0;
    }

    override focus(options?: FocusOptions): void {
        this.ensureSetup();
        this.term.focus();
        if (options) {
            super.focus(options);
        }
    }

    /**
     * Pin the terminal to whatever row count fits `height` px, disabling the
     * dynamic growth: the row count becomes real, is reported to the pty, and
     * every row is shown whether or not it holds anything. Pass `null` to go
     * back to growing from the content, with the row count capped by
     * `maxHeight` px (typically the containing box's max-height) rather than
     * the `max-rows` attribute.
     */
    fit(height: number | null, maxHeight: number | null = this.boxHeight): void {
        this.ensureSetup();
        this.boxHeight = maxHeight;
        this.fixedHeight = height;
        this.resizeTerminal(height === null ? this.dynamicRows() : this.rowsForHeight(height));
        this.measure();
    }

    /**
     * Enable or disable the terminal's cursor. When disabled, the real xterm
     * cursor is hidden and kept hidden across writes, and the squashed (sliver)
     * cursor is suppressed too; when re-enabled, both resume their normal
     * behaviour (the real cursor stays hidden only while a newline is held).
     */
    setCursorEnabled(on: boolean): void {
        this.ensureSetup();
        on = Boolean(on);
        if (on === this.cursorEnabled) {
            return;
        }
        this.cursorEnabled = on;
        this.term.options.cursorBlink = on;
        if (!on) {
            // Hide the real cursor now; the pump won't re-show it while disabled.
            if (!this.cursorHidden) {
                this.cursorHidden = true;
                this.term.write("\x1b[?25l");
            }
            this.stubOn = false;
        } else if (this.cursorHidden && !this.holding()) {
            // Re-show unless a held newline is currently standing in for it.
            this.cursorHidden = false;
            this.term.write("\x1b[?25h");
        }
        this.apply();
    }

    // ----------------------------------------------------------------- setup

    private ensureSetup(): void {
        if (this.initialized) {
            return;
        }
        this.initialized = true;
        this.maxRows = this.readMaxRows();

        const clip = (<div className="embedded-term-clip" />) as HTMLElement;
        const stub = (<div className="embedded-term-cursor" />) as HTMLElement;
        this.clip = clip;
        this.stub = stub;
        this.append(clip, stub);

        this.term = new Terminal({
            cols: this.fittedCols(80),
            rows: this.maxRows,
            scrollback: 1000,
            cursorBlink: true,
            fontFamily: '"Menlo", "Consolas", monospace',
            fontSize: 13,
            theme: THEME,
        });

        // open() measures the character cell, so the host must have layout at
        // that moment — hence `auto` here and the clamp in apply() right after.
        clip.style.height = "auto";
        this.term.open(clip);

        // Appended after open() so they follow .xterm in DOM order as well as
        // in z-index.
        this.fadeTop = (
            <div className="embedded-term-fade embedded-term-fade-top" />
        ) as HTMLElement;
        this.fadeBottom = (
            <div className="embedded-term-fade embedded-term-fade-bottom" />
        ) as HTMLElement;
        clip.append(this.fadeTop, this.fadeBottom);

        this.syncClearHook();
        this.wireEvents();

        this.usedRows = 0;
        this.apply();
    }

    // Opt-in via the ed2-clears-scrollback attribute.
    //
    // `clear(1)` sends ESC[3J (terminfo E3) ahead of the clear, so it already
    // drops the scrollback — but Ctrl-L does not: bash's readline and fish both
    // bind it to clear-screen, which emits only the `clear` capability,
    // ESC[H ESC[2J. With the attribute set, a bare erase-in-display on the
    // normal buffer is promoted into a scrollback-clearing one, so every clear
    // starts genuinely fresh. Returning false means "not handled", so xterm's
    // own ED still runs.
    //
    // The tradeoff, and why this is not the default: it overrides what the
    // application asked for. A program that clears the screen without switching
    // to the alternate buffer — an ncurses app that repaints in place — would
    // lose the scrollback on every repaint.
    private syncClearHook(): void {
        const wanted = this.hasAttribute("ed2-clears-scrollback");
        if (wanted === (this.clearHook !== null)) {
            return;
        }
        if (!wanted) {
            this.clearHook?.dispose();
            this.clearHook = null;
            return;
        }
        this.clearHook = this.term.parser.registerCsiHandler(
            { final: "J" },
            (params: (number | number[])[]) => {
                const p = typeof params[0] === "number" ? params[0] : 0;
                if (p === 2 && this.term.buffer.active.type === "normal") {
                    this.term.write("\x1b[3J"); // queued: lands right after this ED 2
                }
                return false;
            },
        );
    }

    private wireEvents(): void {
        // onWriteParsed and onCursorMove fire at parse time, so they still work
        // while rendering is paused — a fully clipped terminal does not
        // intersect the viewport, which pauses xterm's RenderService, so
        // driving growth off onRender alone would deadlock at height 0.
        this.term.onWriteParsed(() => this.measure());
        this.term.onCursorMove(() => this.measure());
        this.term.onRender(() => this.measure());
        this.term.onScroll(() => this.measure());
        this.term.buffer.onBufferChange(() => this.measure());
        this.term.onResize(() => {
            this.usedRows = Math.min(this.usedRows, this.term.rows);
            this.measure();
        });
        this.term.onData((data: string) => {
            this.dispatchEvent(new CustomEvent("term-data", { detail: data, bubbles: true }));
        });

        // Public on recent builds only.
        const withDims = this.term as unknown as {
            onDimensionsChange?: (cb: () => void) => void;
        };
        withDims.onDimensionsChange?.(() => this.apply());

        const textarea = this.term.textarea;
        if (textarea) {
            textarea.addEventListener("focus", () => this.stub.classList.remove("unfocused"));
            textarea.addEventListener("blur", () => this.stub.classList.add("unfocused"));
            if (document.activeElement !== textarea) {
                this.stub.classList.add("unfocused");
            }
        }
    }

    // =====================================================================
    // Held trailing newlines
    //
    // Rather than inferring the squashed cursor from what is blank in the
    // buffer, the newline itself is held back. When a chunk ends with a newline
    // and writing it would either spill onto a row that is not shown yet or
    // scroll the screen, it is not sent: the squashed cursor is drawn instead,
    // and the newline goes out ahead of the next chunk to arrive, whose own
    // tail is then judged the same way.
    //
    // This is what makes the squashed cursor survive a screenful of output.
    // After a thousand lines every row is instantiated and nothing is blank, so
    // a blank-row test finds nothing to hide — but the pending newline is still
    // pending, and that is what the cursor is really showing.
    //
    // Only the "\n" is ever held. CR and LF are separate controls and always
    // come in that order: CR merely moves to column 0 of the row we are already
    // on, so it goes straight through — which also means the cursor is really
    // at column 0 while holding, and a trailing CR (a progress bar redrawing
    // itself) is never delayed. It handles a CRLF split across two chunks for
    // free: the CR leaves with the first chunk, the LF arrives as the whole
    // tail of the second.
    // =====================================================================

    private holding(): boolean {
        return this.held === "\n";
    }

    private splitTail(data: string | Uint8Array): [string | Uint8Array, string] {
        if (typeof data === "string") {
            return data.slice(-1) === "\n" ? [data.slice(0, -1), "\n"] : [data, ""];
        }
        const n = data.length;
        return n > 0 && data[n - 1] === 0x0a ? [data.subarray(0, n - 1), "\n"] : [data, ""];
    }

    // Would writing one newline here spill onto a row we do not show, or scroll?
    // With a pinned height every row is visible, so this degenerates to holding
    // only what would scroll.
    private wouldHold(): boolean {
        const buf = this.term.buffer.active;
        if (buf.type === "alternate") {
            return false; // a full-screen app owns its own grid
        }
        if (buf.cursorY >= this.term.rows - 1) {
            return true; // would scroll
        }
        // Recomputed rather than read from `usedRows`, which is refreshed by
        // events that may not have run yet when the write callback fires.
        return buf.cursorY + 1 >= Math.max(this.visibleRows(), this.lastContentRow());
    }

    private pump(): void {
        if (this.writing || this.queue.length === 0) {
            return;
        }
        this.writing = true;
        if (this.cursorHidden && this.cursorEnabled) {
            this.cursorHidden = false;
            this.term.write("\x1b[?25h");
        }
        // The held newline goes out ahead of the chunk that released it.
        const pending = this.held;
        this.held = "";
        const [body, tail] = this.splitTail(this.queue.shift()!);

        // The decision needs a current cursor, so it hangs off the last write.
        const writes: (string | Uint8Array)[] = [];
        if (pending) {
            writes.push(pending);
        }
        if (body.length > 0) {
            writes.push(body);
        }
        if (writes.length === 0) {
            this.decideTail(tail);
            return;
        }
        for (let i = 0; i < writes.length - 1; i++) {
            this.term.write(writes[i]);
        }
        this.term.write(writes[writes.length - 1], () => this.decideTail(tail));
    }

    private decideTail(tail: string): void {
        if (!tail) {
            this.finish();
        } else if (this.wouldHold()) {
            this.held = tail;
            this.finish();
        } else {
            this.term.write(tail, () => this.finish());
        }
    }

    private finish(): void {
        this.writing = false;
        // Hide the real cursor while a newline is held: the squashed cursor is
        // standing in for it, and drawing both would lie about where it is.
        if (this.holding() && !this.cursorHidden) {
            this.cursorHidden = true;
            this.term.write("\x1b[?25l");
        }
        this.stubOn = this.holding();
        this.measure();
        this.pump();
    }

    private readMaxRows(): number {
        const n = Number(this.getAttribute("max-rows"));
        return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_MAX_ROWS;
    }

    // ------------------------------------------------------------------ sizing

    private dims(): RenderDims | undefined {
        // Called from fittedCols() while computing the Terminal constructor's
        // `cols`, i.e. before `this.term` is assigned — so guard against it.
        if (!this.term) {
            return undefined;
        }
        const t = this.term as unknown as {
            dimensions?: RenderDims;
            _core?: { _renderService?: { dimensions?: RenderDims } };
        };
        return t.dimensions ?? t._core?._renderService?.dimensions;
    }

    private cellHeight(): number {
        return this.dims()?.css.cell.height ?? 0;
    }

    private rowsForHeight(height: number): number {
        const cell = this.cellHeight();
        return cell ? Math.max(1, Math.floor(height / cell)) : this.maxRows;
    }

    /** The row count while in dynamic sizing: whatever fits the box's
     *  max-height, else the `max-rows` attribute. */
    private dynamicRows(): number {
        return this.boxHeight === null ? this.maxRows : this.rowsForHeight(this.boxHeight);
    }

    private fittedCols(fallback: number): number {
        const attr = Number(this.getAttribute("cols"));
        if (Number.isFinite(attr) && attr >= 2) {
            return Math.floor(attr);
        }
        const cell = this.dims()?.css.cell.width ?? 0;
        const width = this.clientWidth;
        return cell && width ? Math.max(2, Math.floor(width / cell)) : fallback;
    }

    private resizeTerminal(rows: number): void {
        const cols = this.fittedCols(this.term.cols);
        if (cols !== this.term.cols || rows !== this.term.rows) {
            this.term.resize(cols, rows);
        } else {
            this.apply();
        }
    }

    // Width changed (or the cols attribute did): refit the columns, and the rows
    // too when they are pinned to a height.
    private refit(): void {
        if (!this.initialized) {
            return;
        }
        const rows =
            this.fixedHeight === null ? this.dynamicRows() : this.rowsForHeight(this.fixedHeight);
        this.resizeTerminal(rows);
    }

    /** Rows the clip currently shows. */
    private visibleRows(): number {
        if (this.fixedHeight !== null) {
            return this.term.rows; // pinned: everything is visible
        }
        return this.inAlt ? this.term.rows : this.usedRows;
    }

    // ---------------------------------------------------------------- growth

    private isBlank(y: number): boolean {
        const buf = this.term.buffer.active;
        const line = buf.getLine(buf.viewportY + y);
        return !line || line.translateToString(true).length === 0;
    }

    /** Last row holding anything, as a 1-based count. */
    private lastContentRow(): number {
        let last = 0;
        for (let y = 0; y < this.term.rows; y++) {
            if (!this.isBlank(y)) {
                last = y + 1;
            }
        }
        return last;
    }

    // `stubOn` is owned by the hold machinery; this only sizes the clip.
    private measure(): void {
        if (!this.initialized) {
            return;
        }
        if (this.fixedHeight !== null) {
            this.apply();
            return;
        }

        const buf = this.term.buffer.active;
        this.inAlt = buf.type === "alternate";

        // While the alt buffer is up, show the full grid but leave the normal
        // buffer's high-water mark alone, so leaving it restores the old clip.
        if (this.inAlt) {
            this.apply();
            return;
        }

        if (buf.baseY > 0) {
            // Scrolling has started, so every row is in use from here on.
            this.usedRows = this.term.rows;
            this.apply();
            return;
        }

        const content = this.lastContentRow();
        const cy = buf.cursorY;

        // Nothing written and nothing pending: height 0 with only the squashed
        // cursor, whose row is clipped away along with the rest of row 0.
        // `usedRows` never decreases, so this can only be the initial state —
        // never the aftermath of a clear.
        if (
            !this.holding() &&
            !this.writing &&
            this.usedRows === 0 &&
            content === 0 &&
            cy === 0 &&
            buf.cursorX === 0
        ) {
            this.stubOn = true;
            this.apply();
            return;
        }

        // The cursor's row is always revealed. When a newline is held that row
        // is finished — the break is pending — so it is exactly the row to
        // show, with the sliver on its bottom edge. That is what makes one
        // newline reveal one row.
        this.usedRows = Math.min(Math.max(this.usedRows, content, cy + 1), this.term.rows);
        this.apply();
    }

    // ---------------------------------------------------------------- painting

    private apply(): void {
        const dims = this.dims();
        const cell = dims?.css.cell;
        if (!dims || !cell?.height) {
            return; // not measured yet; onDimensionsChange will bring us back
        }
        const clipHeight = Math.round(this.visibleRows() * cell.height);
        this.clip.style.height = `${clipHeight}px`;

        if (this.stubOn && !this.inAlt && this.cursorEnabled) {
            // The CR was written through, so the real column is where the
            // phantom cursor belongs.
            const cursorX = this.term.buffer.active.cursorX;
            const theme = this.term.options.theme;
            this.stub.style.display = "block";
            this.stub.style.height = `${SLIVER_HEIGHT}px`;
            this.stub.style.top = `${Math.round(clipHeight - SLIVER_HEIGHT / 2)}px`;
            this.stub.style.left = `${Math.round(cursorX * cell.width)}px`;
            this.stub.style.width = `${Math.max(2, Math.round(cell.width))}px`;
            this.stub.style.background = theme?.cursor ?? theme?.foreground ?? "#fff";
            this.stub.classList.toggle("blink", !!this.term.options.cursorBlink);
            // Restart the blink on every move so the cursor is solid the instant
            // it lands, rather than caught mid-cycle.
            const key = `${cursorX}:${clipHeight}`;
            if (key !== this.stubKey) {
                this.stubKey = key;
                this.restartBlink();
            }
        } else {
            this.stub.style.display = "none";
            this.stubKey = "";
        }

        this.applyFades(cell.height);
    }

    private restartBlink(): void {
        this.stub.style.animation = "none";
        void this.stub.offsetHeight; // force a reflow so the animation restarts
        this.stub.style.animation = "";
    }

    private applyFades(cellHeight: number): void {
        const buf = this.term.buffer.active;
        const enabled = !this.hasAttribute("no-fade");
        const top = enabled && buf.viewportY > 0;
        const bottom = enabled && buf.viewportY < buf.baseY;
        const height = `${Math.max(FADE_MIN, Math.round(FADE_ROWS * cellHeight))}px`;

        this.fadeTop.style.display = top ? "block" : "none";
        this.fadeBottom.style.display = bottom ? "block" : "none";
        if (top) {
            this.fadeTop.style.height = height;
        }
        if (bottom) {
            this.fadeBottom.style.height = height;
        }
    }
}

if (typeof customElements !== "undefined") {
    if (!customElements.get("embedded-term")) {
        customElements.define("embedded-term", EmbeddedTerm);
    }
}

declare module "myjsx/jsx-runtime" {
    namespace JSX {
        interface CustomElements {
            "embedded-term": DomProps<EmbeddedTerm>;
        }
    }
}
