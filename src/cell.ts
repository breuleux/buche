import { BucheGui, GUI_APPEAR_EVENT } from "./components/buche-gui.tsx";
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

    /**
     * JavaScript to execute. Evaluated as an expression when `response_id`
     * is set (the value is sent back); as statements otherwise.
     */
    code: string;

    /** CSS selector of the targets; `code` runs once per target, with `this` bound to it. */
    selector?: string;

    /** If set, the GUI responds with a `response` carrying the result (or error). */
    response_id?: string;
}

export interface HtmlCommand {
    type: "html";

    /** How to inject the content; defaults to "append". */
    mode?: "append" | "set" | "replace";

    /** CSS selector of the injection targets; defaults to the document body. */
    selector?: string;

    /** HTML to inject (scripts in it are re-created so they execute). */
    content: string;
}

export interface RegisterCommand {
    type: "register";

    /** Message type -> handler source, e.g. `{"foo": "(msg) => {...}"}`. */
    handlers: Record<string, string>;
}

export interface RegisterSchemasCommand {
    type: "register_schemas";

    /** Schema spec (e.g. `"buche:plain"`) -> handler source for `data` payloads. */
    schemas: Record<string, string>;
}

export interface ResolveCommand {
    type: "resolve";

    /**
     * Correlates with the GUI's original resource request; when absent, the
     * command pre-pushes the resource into the GUI's cache under `path`.
     */
    request_id?: string;

    /** Resource path (cache push when there is no `request_id`). */
    path?: string;

    /** HTTP-like status for the resolution (e.g. 200/404). */
    status?: number;

    /** Resource body; text or base64 depending on `encoding`. */
    content?: string;

    /** MIME type of `content`. */
    mimetype?: string;

    /** Encoding of `content`, e.g. `"utf-8"` or `"base64"`. */
    encoding?: string;
}

export interface ResponseCommand {
    type: "response";

    /** Correlates with the request (`buche.request`, or an `exec` with a
     *  `response_id`) this answers. */
    response_id: string;

    /** Result value of a successful request. */
    value?: Json;

    /** Error description of a failed request. */
    error?: string;
}

export type CellCommand =
    | TextCommand
    | DataCommand
    | ExecCommand
    | HtmlCommand
    | RegisterCommand
    | RegisterSchemasCommand
    | ResolveCommand
    | ResponseCommand;

/** Cell configuration (nothing yet: what a cell shows is up to what it is sent). */
// biome-ignore lint/suspicious/noEmptyInterface: extended by cell_configure
export interface CellConfiguration {}

/** Counter behind the per-cell ids under which GUI iframes serve `proc://`. */
let guiSeq = 0;

export class Cell extends WithId() implements CellConfiguration {
    /**
     * The terminal view is only there in case it's needed (a placeholder's,
     * to take input before any output): it goes away if a GUI comes first.
     */
    provisional = false;

    constructor(config: CellConfiguration) {
        super();
        this.configure(config);
    }

    configure(config: CellConfiguration) {}

    /** Give the box a terminal right away, provisionally (see `provisional`). */
    provideTerminal(entry: Entry, box: EchoBox): void {
        this.handle$text({ type: "text", stream: "stdout", text: "" }, entry, box);
        this.provisional = true;
    }

    /** The terminal is in use: it stays, whatever comes next. */
    settle(): void {
        this.provisional = false;
    }

    /** The cell's GUI view, creating it (and the <buche-gui> iframe) on first
     *  use. */
    ensureGui(box: EchoBox): BucheGui {
        const existing = box.getView("gui")?.firstElementChild;
        if (existing instanceof BucheGui) {
            return existing;
        }
        const gui = new BucheGui();
        gui.setAttribute("proc-cell-id", `c${++guiSeq}`);
        if (!gui.hasAttribute("sandbox")) {
            gui.setAttribute("sandbox", "allow-scripts");
        }
        if (this.provisional) {
            box.removeView("pty");
            this.provisional = false;
        }
        box.setView("gui", gui);
        box.showView("gui");
        // Announce the arrival: the interface moves the focus to the GUI
        // (the box itself, if already focused, commits it via the
        // focus-commit-request that setView/showView bubbling already raised).
        gui.dispatchEvent(new CustomEvent(GUI_APPEAR_EVENT, { bubbles: true, composed: true }));
        return gui;
    }

    /** Forward a command to the GUI view, flagging it as holding unseen
     *  content when it is not the active view. */
    sendToGui(message: CellCommand, box: EchoBox): void {
        this.ensureGui(box).send(message);
        box.bump("gui");
    }

    handle(message: CellCommand, entry: Entry, box: EchoBox) {
        type HT = (m: CellCommand, entry: Entry, box: EchoBox) => void;
        const handler = this[`handle$${message.type}`];
        (handler as HT).call(this, message, entry, box);
    }

    handle$text(message: TextCommand, entry: Entry, box: EchoBox) {
        if (message.text !== "") {
            this.settle();
        }
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
            // A box that is its pane's whole content fills it, so with no
            // drag height the grid is pinned to the rendered cell height — the
            // terminal spans the whole pane (see the `echo-box[fills]` CSS).
            // Boxes in a scroll stream keep dynamic sizing — except when there
            // is a GUI view: then the terminal matches the GUI's height, so
            // switching views does not change the box's size.
            const fit = () => {
                const fillsPane = box.hasAttribute("fills");
                const explicit = box.cellContentHeight;
                if (explicit !== null) {
                    view.fit(explicit, box.maxContentHeight);
                    return;
                }
                if (fillsPane) {
                    const height = box.cellSize.height;
                    view.fit(height > 0 ? height : null, box.maxContentHeight);
                    return;
                }
                // The GUI's reported height, read from the inline the iframe
                // reporting left (offsetHeight is 0 while the GUI view is the
                // hidden one).
                const gui = box.getView("gui")?.firstElementChild as HTMLElement | null;
                const reported = Number.parseFloat(gui?.style.height ?? "");
                const height = Number.isFinite(reported) && reported > 0 ? reported : null;
                view.fit(height, box.maxContentHeight);
            };
            box.addEventListener("resize", fit);
            // A GUI that grows or shrinks takes the terminal's height with it.
            box.addEventListener("gui-resize", fit);
            fit();
        }
        view.write(message.text);
        // A message landing in a view that is not shown flags it unseen
        // (no-op when the terminal is the active — or only — view).
        box.bump("pty");
    }

    handle$data(message: DataCommand, entry: Entry, box: EchoBox) {
        this.sendToGui(message, box);
    }

    handle$exec(message: ExecCommand, entry: Entry, box: EchoBox) {
        this.sendToGui(message, box);
    }

    handle$html(message: HtmlCommand, entry: Entry, box: EchoBox) {
        this.sendToGui(message, box);
    }

    handle$register(message: RegisterCommand, entry: Entry, box: EchoBox) {
        this.sendToGui(message, box);
    }

    handle$register_schemas(message: RegisterSchemasCommand, entry: Entry, box: EchoBox) {
        this.sendToGui(message, box);
    }

    handle$resolve(message: ResolveCommand, entry: Entry, box: EchoBox) {
        const gui = this.ensureGui(box);
        if (message.request_id !== undefined) {
            gui.respond(message.request_id, message);
        } else if (message.path !== undefined) {
            gui.cache(message.path, message.content ?? "", message.mimetype, message.encoding);
        }
        box.bump("gui");
    }

    // Answers a request the GUI itself made (`buche.request`); it does not
    // bring the GUI into existence (the request could only come from one).
    handle$response(message: ResponseCommand, entry: Entry, box: EchoBox) {
        const gui = box.getView("gui")?.firstElementChild;
        if (gui instanceof BucheGui) {
            gui.send(message);
            box.bump("gui");
        }
    }
}
