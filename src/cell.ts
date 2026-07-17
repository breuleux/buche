import type { EchoBox } from "./components/echo-box.tsx";
import { EmbeddedTerm } from "./components/embedded-term.tsx";
import type { Entry } from "./entry.ts";
import type { Json } from "./types.ts";
import { WithId } from "./utils.ts";

export interface TextCommand {
    type: "text";
    stream: string;
    text: string;
}

export interface DataCommand {
    type: "data";
    data: Json;
}

export interface ExecCommand {
    type: "exec";
    code: string;
}

export type CellCommand = TextCommand | DataCommand | ExecCommand;

// Nothing for now (`sticky` and `background` moved to the echo configuration).
// biome-ignore lint/suspicious/noEmptyInterface: extension point for cell options
export interface CellConfiguration {}

export class Cell extends WithId() implements CellConfiguration {
    zones: Record<string, never>; // cells do not define zones currently

    constructor(config: CellConfiguration) {
        super();
        this.configure(config);
        this.zones = {};
    }

    configure(config: CellConfiguration) {
        Object.assign(this, config);
    }

    handle(message: CellCommand, entry: Entry, box: EchoBox) {
        type HT = (m: CellCommand, entry: Entry, box: EchoBox) => void;
        const handler = this[`handle$${message.type}`];
        (handler as HT).call(this, message, entry, box);
    }

    handle$text(message: TextCommand, entry: Entry, box: EchoBox) {
        let view = box.getView("pty")?.childNodes[0] as EmbeddedTerm;
        if (!view) {
            view = new EmbeddedTerm();
            // Ctrl-L (a bare ED 2 clear) drops the scrollback too, the way
            // `clear(1)` does (see the ed2-clears-scrollback attribute).
            view.setAttribute("ed2-clears-scrollback", "");
            const cursorTerm = view;
            entry.listeners.push((entry: Entry) => {
                const st = entry.echo.status.status;
                if (st === "done" || st === "error") {
                    cursorTerm.setCursorEnabled(false);
                } else {
                    cursorTerm.setCursorEnabled(true);
                }
            });
            box.setView("pty", view);
            // Dynamic sizing (rows grow with content) is the default, capped
            // by the box's max-height; a user drag pins the rows to the
            // dragged height, and double-clicking the bar frees it again.
            // A box placed directly in a tab-pane pane fills it, so with no
            // drag height the grid is pinned to the rendered cell height — the
            // terminal spans the whole pane (see the `.tab-pane-pane > echo-box`
            // CSS). Boxes inside a <buche-term> keep dynamic sizing.
            const fillsPane = box.parentElement?.classList.contains("tab-pane-pane") ?? false;
            const fit = () => {
                if (fillsPane && box.cellContentHeight === null) {
                    const height = box.cellSize.height;
                    view.fit(height > 0 ? height : null, box.maxContentHeight);
                    return;
                }
                view.fit(box.cellContentHeight, box.maxContentHeight);
            };
            box.addEventListener("resize", fit);
            fit();
        }
        view.write(message.text);
    }

    handle$data(message: TextCommand, entry: Entry, box: EchoBox) {
        throw Error("not implemented");
    }

    handle$exec(message: TextCommand, entry: Entry, box: EchoBox) {
        throw Error("not implemented");
    }
}
