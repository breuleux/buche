import { Cell, type CellCommand } from "../cell.ts";
import { BucheGui, GUI_APPEAR_EVENT } from "../components/buche-gui.tsx";
import type { EchoBox } from "../components/echo-box.tsx";
import type { Entry } from "../entry.ts";

/** Counter behind the per-cell ids under which GUI iframes serve `proc://`. */
let guiSeq = 0;

/**
 * A frame: an HTML page the driver drives (a GUI, in a <buche-gui> iframe).
 * It takes every command but `text` (see `commandKind`).
 */
export class FrameCell extends Cell {
    readonly kind = "frame";

    initialize(entry: Entry, box: EchoBox): void {
        this.ensureGui(box);
    }

    handle(command: CellCommand, entry: Entry, box: EchoBox): void {
        switch (command.type) {
            case "resolve": {
                const gui = this.ensureGui(box);
                if (command.request_id !== undefined) {
                    gui.respond(command.request_id, command);
                } else if (command.path !== undefined) {
                    gui.cache(
                        command.path,
                        command.content ?? "",
                        command.mimetype,
                        command.encoding,
                    );
                }
                return;
            }
            case "response": {
                // Answers a request the GUI itself made (`buche.request`): it
                // does not bring the GUI into existence (the request could
                // only come from one).
                const gui = box.content;
                if (gui instanceof BucheGui) {
                    gui.send(command);
                }
                return;
            }
            default:
                this.ensureGui(box).send(command);
        }
    }

    /** Throw the GUI away for a blank one (a fresh iframe: no DOM, no script
     *  state, no cached resources), which takes the focus only if `focus`
     *  (the old one had it). A frame with no GUI yet gets its first. */
    reset(entry: Entry, box: EchoBox, focus: boolean): void {
        this.makeGui(box, focus);
    }

    /** The frame's GUI (the <buche-gui> iframe), creating it on first use. */
    ensureGui(box: EchoBox): BucheGui {
        const existing = box.content;
        if (existing instanceof BucheGui) {
            return existing;
        }
        return this.makeGui(box, true);
    }

    /** Put a new GUI in the box, in place of whatever it showed. */
    private makeGui(box: EchoBox, focus: boolean): BucheGui {
        const gui = new BucheGui();
        gui.setAttribute("proc-cell-id", `c${++guiSeq}`);
        if (!gui.hasAttribute("sandbox")) {
            gui.setAttribute("sandbox", "allow-scripts");
        }
        // In place of the terminal of the placeholder this cell took over.
        box.setContent(gui);
        // Announce the arrival: the interface moves the focus to the GUI (the
        // box itself, if already focused, commits it via the
        // focus-commit-request that setContent already raised).
        gui.dispatchEvent(
            new CustomEvent(GUI_APPEAR_EVENT, {
                bubbles: true,
                composed: true,
                detail: { focus },
            }),
        );
        return gui;
    }
}
