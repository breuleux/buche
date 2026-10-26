import type { CellConfiguration, ViewKind } from "../cell.ts";
import { PromptCell, type PromptConfiguration } from "../cells/prompt.ts";
import type { Buche } from "../core.ts";
import type { BaseMessage, CreationInfo } from "./common.ts";

/** The fields that make (or retune) what an entry shows. */
export interface ViewConfiguration extends PromptConfiguration {
    /**
     * What the entry shows: a terminal, a frame (a GUI), or a prompt (the prompt fields,
     * `bindings`, `input` and `request_id`, then apply). What it is sent must
     * suit it (text for a terminal, the rest for a frame). An entry cannot
     * change kind: a kind other than the one it has is an error.
     */
    kind?: ViewKind;

    /**
     * For a prompt: set when this message is the *echo* answering a parse
     * (the highlight a keystroke triggered): it repeats that parse's
     * `request_id`, and is only applied while that parse is still the latest
     * for this prompt — a stale echo (the user typed on in the meantime) is
     * dropped. Absent (the norm) for authoritative configurations: the fresh
     * prompt, the submit reset, history navigation.
     */
    request_id?: string;
}

/**
 * Declares (or reconfigures) an entry. It carries the cell configuration
 * (label, color, `represents`, `ephemeral`, ...), which the entry's views
 * show too, and says where the entry goes (`zone`).
 *
 * With a `kind`, the entry shows something itself: a terminal, a frame or a
 * prompt (see {@link ViewConfiguration.kind}); the first time, it takes the
 * place of its parent's placeholder if it can. Without, it is a process, or
 * any non-visual parent of cells and prompts: the first time, it gets a
 * placeholder (`<from>.?`), an empty cell placed in `zone` that stands in for
 * the first cell or prompt the entry shows (see `Buche.claim`), and takes its
 * input meanwhile.
 */
export interface ConfigureMessage
    extends BaseMessage,
        CreationInfo,
        CellConfiguration,
        ViewConfiguration {
    type: "configure";
}

export function handle$configure(buche: Buche, obj: ConfigureMessage): void {
    if (obj.request_id !== undefined) {
        // A keystroke echo: pure content refresh — no installation, no zone
        // and no status changes. Valid only while it answers the latest parse
        // of this prompt; anything older is dropped (it would clobber text
        // typed since, with ranges computed for text that is gone).
        const entry = buche.hierarchy.getAt(obj.from, false);
        const prompt = entry?.cell;
        if (!entry || !(prompt instanceof PromptCell) || prompt.request_id !== obj.request_id) {
            return;
        }
        prompt.configurePrompt(obj);
        buche.sendInterface({ type: "update_cell", target: null, entry });
        return;
    }
    if (obj.kind !== undefined) {
        configureView(buche, obj, obj.kind);
        return;
    }
    const fresh = buche.hierarchy.getAt(obj.from, false) === null;
    const entry = buche.ensure(obj);
    if (!fresh) {
        buche.relook(entry, obj);
    }
    // Declaring a process marks it running; reconfiguring one that has
    // already started (or ended) leaves its status alone.
    if (entry.cell.status.status === "absent") {
        entry.cell.status = { status: obj.status ?? "running" };
    }
    // A reconfiguration does not move anything: the placeholder is made once.
    buche.ensurePlaceholder(entry, obj.zone);
}

/**
 * Make (or retune) the cell of `kind` that the entry at `obj.from` shows. A
 * new one takes its parent's placeholder over if it can, and otherwise goes
 * where `zone` says (by default: a cell inline, or in a tab beside its
 * parent's; a prompt in a new tab, linked to the prompt it lands next to). A
 * retune keeps it where it is.
 */
function configureView(buche: Buche, obj: ConfigureMessage, kind: ViewKind): void {
    const existing = buche.hierarchy.getAt(obj.from, false);
    if (existing) {
        buche.checkKind(existing, kind);
    }
    const claimed = buche.claim(obj.from, kind) !== null;
    const entry = buche.ensure(obj);
    const fresh = !entry.visual;
    let target = null;
    if (fresh) {
        entry.replaceCell(kind);
        target = entry.target = buche.targetFor(entry, obj.zone, kind);
    }
    if (entry.cell instanceof PromptCell) {
        // Any parse still awaiting its answer is now void. A live prompt
        // (submit reset, cd, config reload) keeps its status.
        entry.cell.request_id = null;
        entry.cell.configurePrompt(obj);
        if (fresh || claimed) {
            entry.cell.status = { status: "running" };
        }
    } else if (obj.status === undefined || entry.representative() !== null) {
        entry.cell.status = { status: "running" };
    }
    buche.sendInterface({ type: "update_cell", target, entry });
}
