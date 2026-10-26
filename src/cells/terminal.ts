import { Cell, type CellCommand, isSpent } from "../cell.ts";
import type { EchoBox } from "../components/echo-box.tsx";
import { EmbeddedTerm } from "../components/embedded-term.tsx";
import type { Entry } from "../entry.ts";

/**
 * The box's terminal, creating it on first use. Dynamic sizing (rows grow
 * with content) is the default, capped by the box's max-height. A box that is
 * its pane's whole content fills it, so the grid is pinned to the rendered
 * cell height — the terminal spans the whole pane (see the `echo-box[fills]`
 * CSS). Boxes in a scroll stream keep dynamic sizing.
 */
export function ensureTerminal(entry: Entry, box: EchoBox): EmbeddedTerm {
    const existing = box.content;
    if (existing instanceof EmbeddedTerm) {
        return existing;
    }
    const term = new EmbeddedTerm();
    // Ctrl-L (a bare ED 2 clear) drops the scrollback too, the way `clear(1)`
    // does (see the ed2-clears-scrollback attribute).
    term.setAttribute("ed2-clears-scrollback", "");
    entry.listeners.push((entry: Entry) => {
        term.setCursorEnabled(!isSpent(entry.cell.status.status));
    });
    box.setContent(term);
    const fit = () => {
        if (box.hasAttribute("fills")) {
            const height = box.cellSize.height;
            term.fit(height > 0 ? height : null, box.maxContentHeight);
        } else {
            term.fit(null, box.maxContentHeight);
        }
    };
    box.addEventListener("resize", fit);
    fit();
    return term;
}

/** A terminal: it takes `text` (see `commandKind`). A placeholder's
 *  terminal, when it takes the placeholder over, stays (it is the same box). */
export class TerminalCell extends Cell {
    readonly kind = "terminal";

    initialize(entry: Entry, box: EchoBox): void {
        ensureTerminal(entry, box);
    }

    /** Reset the terminal to as new — screen, scrollback and modes gone —
     *  but the rows stay revealed, so a rerun does not flicker the height.
     *  (The same terminal stays, so the focus is left alone.) */
    reset(entry: Entry, box: EchoBox, focus: boolean): void {
        ensureTerminal(entry, box).reset();
    }

    handle(command: CellCommand, entry: Entry, box: EchoBox): void {
        if (command.type === "text") {
            ensureTerminal(entry, box).write(command.text);
        }
    }
}
