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

/** Cell view layout.
 *  - `"split"`: `text` commands go to the terminal view, GUI commands to the
 *    GUI view (the two are switchable).
 *  - `"unified"`: no terminal; `text` commands are sent to the GUI as a
 *    special case of the `data` command (schema `"buche:text"`). */
export type CellMode = "split" | "unified";

export interface CellConfiguration {
    mode?: CellMode;
}

/** Counter behind the per-cell ids under which GUI iframes serve `proc://`. */
let guiSeq = 0;

export class Cell extends WithId() implements CellConfiguration {
    zones: Record<string, never>; // cells do not define zones currently

    /** How the terminal and GUI views are used (see {@link CellMode}). */
    mode: CellMode = "split";

    constructor(config: CellConfiguration) {
        super();
        this.configure(config);
        this.zones = {};
    }

    configure(config: CellConfiguration) {
        Object.assign(this, config);
        if (this.mode !== "split" && this.mode !== "unified") {
            this.mode = "split";
        }
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

    /** Bring the box in line with the mode. A unified cell has no terminal
     *  view: switching to unified removes it, forwarding whatever it held to
     *  the GUI as text. Call after each (re)configuration. */
    applyMode(box: EchoBox): void {
        if (this.mode !== "unified") {
            return;
        }
        const pty = box.getView("pty")?.firstElementChild;
        if (!(pty instanceof EmbeddedTerm)) {
            return;
        }
        // The terminal parses asynchronously: wait for its content to settle
        // before lifting it out.
        void pty.flush().then(() => {
            if (box.getView("pty")?.firstElementChild !== pty) {
                return;
            }
            const text = pty.getText();
            if (text !== "") {
                this.sendToGui(
                    { type: "data", data: { $schema: "buche:text", text, stream: "stdout" } },
                    box,
                );
            }
            box.removeView("pty");
        });
    }

    handle(message: CellCommand, entry: Entry, box: EchoBox) {
        type HT = (m: CellCommand, entry: Entry, box: EchoBox) => void;
        const handler = this[`handle$${message.type}`];
        (handler as HT).call(this, message, entry, box);
    }

    handle$text(message: TextCommand, entry: Entry, box: EchoBox) {
        if (this.mode === "unified") {
            // No terminal: text is a special case of the data command.
            this.sendToGui(
                {
                    type: "data",
                    data: { $schema: "buche:text", text: message.text, stream: message.stream },
                },
                box,
            );
            return;
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
            // A box placed directly in a tab-pane pane fills it, so with no
            // drag height the grid is pinned to the rendered cell height — the
            // terminal spans the whole pane (see the `.tab-pane-pane > echo-box`
            // CSS). Boxes inside a <buche-term> keep dynamic sizing — except
            // when there is a GUI view: then the terminal matches the GUI's
            // height, so switching views does not change the box's size.
            const fillsPane = box.parentElement?.classList.contains("tab-pane-pane") ?? false;
            const fit = () => {
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
