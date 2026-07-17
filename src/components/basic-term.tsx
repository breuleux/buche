// A windowed terminal view as a custom element: `<basic-term>`.
//
//   <basic-term initial-lines="100" keep-lines="1000"
//               initial-bytes="15000" keep-bytes="150000"></basic-term>
//
//   const term = document.createElement("basic-term") as BasicTerm;
//   term.write("\x1b[32mhello\x1b[0m world\n");   // feed raw pty output
//
// It keeps the FIRST part of the output and the LAST part, dropping the middle —
// so a command that prints a million lines stays responsive. Internally it hosts
// a <scroll-fader> containing two <basic-ansi> regions:
//
//   ┌ scroll-fader ────────────────┐
//   │ head  <basic-ansi>           │  first `initial-lines` lines OR
//   │   …first N lines…            │  `initial-bytes` bytes, whichever comes first
//   │ ── separator (N hidden) ──   │
//   │ tail  <basic-ansi>           │  last `keep-lines` lines OR `keep-bytes`
//   │   …last M lines…             │  bytes, whichever binds; older lines pruned
//   └──────────────────────────────┘
//
// When a huge block arrives whose front is going to be pruned anyway, the doomed
// prefix is sliced off BEFORE it is fed through the ANSI parser — so we never pay
// to render content we are about to drop.
//
// Config attributes (all optional):
//   initial-lines  (default 100)         head line budget
//   keep-lines     (default 1000)        tail line budget
//   initial-bytes  (default 150×initial-lines)  head byte budget
//   keep-bytes     (default 150×keep-lines)     tail byte budget
//
// Appearance lives in the companion stylesheet `basic-term.css` (or the
// consolidated components.css).

// Bare side-effect imports register the child custom elements. They must not be
// `import type` (which biome would fold a value-only-used-as-type import into) —
// that would drop the module and its customElements.define, leaving <basic-ansi>
// and <scroll-fader> unregistered.
import "./basic-ansi.tsx";
import "./scroll-fader.tsx";
import type { DomProps } from "myjsx/jsx-runtime";
import type { BasicAnsi } from "./basic-ansi.tsx";
import type { ScrollFader } from "./scroll-fader.tsx";

type CursorState = "active" | "inactive" | "hidden";

// Default bytes-per-line assumption, used to derive byte budgets from the line
// budgets when the *-bytes attributes are not given.
const BYTES_PER_LINE = 150;

function countNewlines(s: string, start: number, end: number): number {
    let n = 0;
    for (let i = start; i < end; i++) {
        if (s[i] === "\n") {
            n++;
        }
    }
    return n;
}

function formatBytes(n: number): string {
    if (n < 1024) {
        return `${n} B`;
    }
    if (n < 1024 * 1024) {
        return `${(n / 1024).toFixed(1)} KB`;
    }
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export class BasicTerm extends HTMLElement {
    private initialized = false;
    private fader!: ScrollFader;
    private head!: BasicAnsi;
    private tail: BasicAnsi | null = null;
    private separator: HTMLElement | null = null;
    private headSealed = false;
    private droppedLines = 0;
    private droppedBytes = 0;

    // Budgets (resolved from attributes in ensureSetup).
    private initialLines = 100;
    private keepLines = 1000;
    private initialBytes = 100 * BYTES_PER_LINE;
    private keepBytes = 1000 * BYTES_PER_LINE;

    connectedCallback(): void {
        this.ensureSetup();
    }

    private ensureSetup(): void {
        if (this.initialized) {
            return;
        }
        this.initialized = true;
        this.readConfig();

        this.fader = document.createElement("scroll-fader") as ScrollFader;
        this.appendChild(this.fader);

        this.head = this.makeRegion();
        this.fader.inner.appendChild(this.head);
    }

    private readConfig(): void {
        const num = (name: string, def: number): number => {
            const raw = this.getAttribute(name);
            if (raw == null) {
                return def;
            }
            const n = Number(raw);
            return Number.isFinite(n) && n >= 0 ? n : def;
        };
        this.initialLines = num("initial-lines", 100);
        this.keepLines = num("keep-lines", 1000);
        this.initialBytes = num("initial-bytes", this.initialLines * BYTES_PER_LINE);
        this.keepBytes = num("keep-bytes", this.keepLines * BYTES_PER_LINE);
    }

    private makeRegion(): BasicAnsi {
        const region = document.createElement("basic-ansi") as BasicAnsi;
        // Bound any single line so one giant newline-less line can't blow up.
        region.maxLineBytes = this.keepBytes;
        return region;
    }

    /** Feed a chunk of raw terminal output (ANSI sequences and all). */
    write(text: string, stream = "stdout"): void {
        this.ensureSetup();
        if (this.headSealed) {
            this.writeTail(text, stream);
        } else {
            this.writeHead(text, stream);
        }
    }

    // Fill the head region until either budget is hit, then seal and spill the
    // remainder into the tail. Only the head-bound slice is fed through ANSI.
    private writeHead(text: string, stream: string): void {
        const byteRoom = this.initialBytes - this.head.byteLength;
        const lineRoom = this.initialLines - this.head.lineCount;
        if (byteRoom <= 0 || lineRoom <= 0) {
            this.sealHead();
            this.writeTail(text, stream);
            return;
        }

        // Find where the head budget runs out (raw chars ≈ bytes; newlines ≈ lines).
        let idx = text.length;
        let chars = 0;
        let nl = 0;
        let hit = false;
        for (let i = 0; i < text.length; i++) {
            chars++;
            if (text[i] === "\n") {
                nl++;
            }
            if (chars >= byteRoom || nl >= lineRoom) {
                idx = i + 1;
                hit = true;
                break;
            }
        }

        this.head.write(text.slice(0, idx), stream);
        if (hit) {
            this.sealHead();
            const rest = text.slice(idx);
            if (rest) {
                this.writeTail(rest, stream);
            }
        }
    }

    private sealHead(): void {
        this.head.setCursorEnabled(false);
        this.separator = this.makeSeparator();
        this.fader.inner.appendChild(this.separator);
        this.tail = this.makeRegion();
        this.fader.inner.appendChild(this.tail);
        this.headSealed = true;
        this.updateSeparator();
    }

    // Append to the tail and prune it back to the keep budgets. A block far
    // larger than the byte budget is trimmed BEFORE ANSI parsing.
    private writeTail(text: string, stream: string): void {
        const tail = this.tail;
        if (!tail) {
            return;
        }

        let src = text;
        if (src.length > this.keepBytes) {
            // Everything but the last keepBytes chars will be pruned anyway — drop
            // it up front so we never ANSI-render it. (ANSI state from the dropped
            // prefix is lost, but that content isn't shown.)
            const cut = src.length - this.keepBytes;
            this.droppedBytes += cut;
            this.droppedLines += countNewlines(src, 0, cut);
            src = src.slice(cut);
        }

        const { cleared } = tail.write(src, stream);
        if (cleared) {
            this.handleClear();
            return;
        }

        const dropped = tail.prune(this.keepBytes, this.keepLines);
        this.droppedLines += dropped.lines;
        this.droppedBytes += dropped.bytes;
        this.updateSeparator();
    }

    // \x1b[2J while in the tail: treat as a screen clear — discard the old head
    // and separator and promote the (freshly cleared) tail to be the new head.
    private handleClear(): void {
        if (!this.tail) {
            this.head.clear();
            return;
        }
        this.head.remove();
        this.separator?.remove();
        this.head = this.tail;
        this.tail = null;
        this.separator = null;
        this.headSealed = false;
        this.droppedLines = 0;
        this.droppedBytes = 0;
        this.head.setCursorEnabled(true);
    }

    /** Reset to a single empty head region. */
    clear(): void {
        this.ensureSetup();
        this.tail?.remove();
        this.separator?.remove();
        this.tail = null;
        this.separator = null;
        this.headSealed = false;
        this.droppedLines = 0;
        this.droppedBytes = 0;
        this.head.clear();
        this.head.setCursorEnabled(true);
    }

    /** Set the live cursor's visual state. */
    setCursorState(state: CursorState): void {
        this.ensureSetup();
        (this.tail ?? this.head).setCursorState(state);
    }

    private makeSeparator(): HTMLElement {
        const sep = document.createElement("div");
        sep.className = "basic-term-separator";
        const label = document.createElement("div");
        label.className = "basic-term-separator-label";
        sep.appendChild(label);
        return sep;
    }

    private updateSeparator(): void {
        if (!this.separator) {
            return;
        }
        const label = this.separator.firstElementChild as HTMLElement;
        const lines = this.droppedLines.toLocaleString("en-US");
        label.textContent =
            this.droppedLines > 0
                ? `⋯ ${lines} lines (${formatBytes(this.droppedBytes)}) dropped ⋯`
                : "⋯";
    }
}

if (typeof customElements !== "undefined") {
    if (!customElements.get("basic-term")) {
        customElements.define("basic-term", BasicTerm);
    }
}

declare module "myjsx/jsx-runtime" {
    namespace JSX {
        interface CustomElements {
            "basic-term": DomProps<BasicTerm>;
        }
    }
}
