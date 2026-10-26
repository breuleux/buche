import { BucheGui, GUI_APPEAR_EVENT } from "./components/buche-gui.tsx";
import type { EchoBox } from "./components/echo-box.tsx";
import { EmbeddedTerm } from "./components/embedded-term.tsx";
import type { Entry } from "./entry.ts";
import type { PromptBindings, PromptConfiguration } from "./prompt.ts";
import type {
    Accent,
    Address,
    Icon,
    Json,
    StyledText,
    Submission,
    SubmissionConfiguration,
} from "./types.ts";
import { applySubmission, emptySubmission, WithId } from "./utils.ts";

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

export type StatusString = "absent" | "running" | "done" | "error" | "unresponsive" | "standby";

export interface Status {
    status: StatusString;
    code?: number | string | null;
}

/**
 * A cell's configuration: how it looks, and how it behaves (the same for any
 * kind of cell). See `configure`.
 */
export interface CellConfiguration {
    /**
     * What was submitted: the command text, and the context it was submitted
     * in (e.g. the prompt it was typed at: host, path, branch). The context,
     * when present, is shown above the echo box in the accent color. A
     * configuration may give either subfield alone; the other keeps its
     * current value. Echos are read-only, always: the content's `editability`
     * (see InteractiveStyledText) defaults to "readonly" here and any value
     * has no effect (only "readonly" is supported for echos for now).
     */
    submission?: SubmissionConfiguration;

    /**
     * The cell/tab label: styled text (its ranges' styles can set the font,
     * e.g. "mono" or "sans"), or a plain string.
     */
    label?: StyledText | string;

    /** Accent color for the component. */
    color?: Accent;

    /** The cell/tab icon, shown before the label. Explicit null removes it. */
    icon?: Icon | null;

    /**
     * The id of the user command this echo answers (repeated from the
     * "command" request's `id`). The interface uses it to give the focus to
     * the echo's element when it appears.
     */
    id?: string;

    /** If true, keep the focus on the cell when its process ends. */
    sticky?: boolean;

    /** If true, do not automatically focus the cell or prompt. */
    background?: boolean;

    /**
     * If true, the element showing this entry (the cell's box, and with it
     * its tab) is removed when the entry is marked done or error. Prompts
     * already go away when their process ends.
     */
    ephemeral?: boolean;

    /**
     * Address of the entry this one stands for (typically the process that
     * owns it). While set, the entry's status mirrors that entry's, and user
     * signals, input and resizes are routed to its address. Explicit null
     * disables the mirroring.
     */
    represents?: Address | null;

    /**
     * Switch the (represented) entry between running and standby. A standby
     * entry is a temporary interface the user may be done with: it is killed
     * by a clear, like spent cells are removed, or once it has stayed scrolled
     * out of view for a while. Ignored once the entry is done or errored.
     */
    status?: "running" | "standby";
}

/**
 * What a cell shows, as a driver declares it: a terminal, a frame (an HTML
 * page the driver drives: a GUI), or a prompt.
 */
export type ViewKind = "terminal" | "frame" | "prompt";

/**
 * What a cell is: a {@link ViewKind}; `pending` — a placeholder, standing in
 * (with a terminal to take input meanwhile) for whatever its process shows
 * first, which takes it over (see `Buche.claim`) and gives it its kind; or
 * `group` — an entry that shows nothing itself (a process, or any parent of
 * cells), whose look and status its views take on. Every entry has a cell,
 * of kind `group` until it shows something.
 */
export type CellKind = ViewKind | "pending" | "group";

/** The DOM id of the element showing the cell answering command `id`. */
export function echoElementId(id: string): string {
    return `echo-${id}`;
}

/** Whether the cell's process can still receive signals (kill, resize, ...). */
export function killable(cell: Cell): boolean {
    const { status } = cell.status;
    return status === "running" || status === "unresponsive" || status === "standby";
}

/** A label as styled text (a plain string has no styling). */
export function toStyledText(label: StyledText | string | undefined): StyledText | undefined {
    return typeof label === "string" ? { text: label, ranges: [] } : label;
}

/** A cell's configuration, to pass on (e.g. to the views of a process). */
export function cellConfiguration(cell: Cell): CellConfiguration {
    return {
        submission: cell.submission ?? undefined,
        label: cell.label,
        color: cell.color,
        icon: cell.icon,
        id: cell.id,
        sticky: cell.sticky,
        background: cell.background,
        ephemeral: cell.ephemeral,
    };
}

/** The kind of cell a command is for. */
export function commandKind(command: CellCommand): "terminal" | "frame" {
    return command.type === "text" ? "terminal" : "frame";
}

/** Counter behind the per-cell ids under which GUI iframes serve `proc://`. */
let guiSeq = 0;

export class Cell extends WithId() {
    /** What the cell is (see {@link CellKind}); it changes as the entry comes
     *  to show something. */
    kind: CellKind;

    /** What was submitted (command text + context), or null until a
     *  configuration provides it. See {@link CellConfiguration.submission}. */
    submission: Submission | null = null;

    /** The cell/tab label. */
    label!: StyledText;

    /** Accent color for the component. */
    color!: Accent;

    /** The cell/tab icon, if any. */
    icon: Icon | null = null;

    /** The id of the user command this cell answers, if any. */
    id?: string;

    /** If true, keep the focus on the cell when its process ends. */
    sticky = false;

    /** If true, do not automatically focus the cell or prompt. */
    background = false;

    /** If true, the showing element is removed once the entry is spent. */
    ephemeral = false;

    /** Status of the component. */
    status: Status = { status: "absent" };

    /** For a prompt: key-chord → action-name map. */
    bindings: PromptBindings = {};

    /** For a prompt: what the user is typing, and the marker above it. */
    input: Submission = {
        content: { text: "", ranges: [], selection: { start: 0, end: 0 } },
        context: { text: "", ranges: [] },
    };

    /**
     * For a prompt, machine bookkeeping (not configuration): the `request_id`
     * of the last parse sent for its content. A highlight echo (a configure
     * with a `request_id`) only applies while it matches. Null once an
     * authoritative configure took over (no parse is awaiting its answer).
     */
    request_id: string | null = null;

    constructor(kind: CellKind, config: CellConfiguration = {}) {
        super();
        this.kind = kind;
        this.configure(config);
    }

    /** Apply a configuration: the fields it gives replace the current ones. */
    configure(config: CellConfiguration) {
        this.label =
            toStyledText(config.label) ?? this.label ?? toStyledText(`%${this.serialId}`)!;
        this.color = config.color ?? this.color ?? "purple";
        if (config.icon !== undefined) {
            this.icon = config.icon;
        }
        if (config.submission) {
            this.submission ??= emptySubmission();
            applySubmission(this.submission, config.submission);
        }
        this.id = config.id ?? this.id;
        this.sticky = config.sticky ?? this.sticky;
        this.background = config.background ?? this.background;
        this.ephemeral = config.ephemeral ?? this.ephemeral;
    }

    /** Apply a prompt's configuration (its bindings and input). */
    configurePrompt(config: PromptConfiguration): void {
        this.bindings = config.bindings ?? this.bindings;
        applySubmission(this.input, config.input);
    }

    /**
     * Give the box the content the cell's kind needs (idempotent: run on every
     * update): a terminal for a terminal, or a placeholder (to take input
     * before any output); a GUI for a frame — which replaces the terminal of
     * the placeholder it took over, if any.
     */
    initialize(entry: Entry, box: EchoBox): void {
        if (this.kind === "terminal" || this.kind === "pending") {
            if (!(box.content instanceof EmbeddedTerm)) {
                this.handle$text({ type: "text", stream: "stdout", text: "" }, entry, box);
            }
        } else if (this.kind === "frame") {
            this.ensureGui(box);
        }
    }

    /** The frame's GUI (the <buche-gui> iframe), creating it on first use. */
    ensureGui(box: EchoBox): BucheGui {
        const existing = box.content;
        if (existing instanceof BucheGui) {
            return existing;
        }
        const gui = new BucheGui();
        gui.setAttribute("proc-cell-id", `c${++guiSeq}`);
        if (!gui.hasAttribute("sandbox")) {
            gui.setAttribute("sandbox", "allow-scripts");
        }
        // In place of the terminal of the placeholder this cell took over.
        box.setContent(gui);
        // Announce the arrival: the interface moves the focus to the GUI
        // (the box itself, if already focused, commits it via the
        // focus-commit-request that setContent already raised).
        gui.dispatchEvent(new CustomEvent(GUI_APPEAR_EVENT, { bubbles: true, composed: true }));
        return gui;
    }

    /** Forward a command to the frame's GUI. */
    sendToGui(message: CellCommand, box: EchoBox): void {
        this.ensureGui(box).send(message);
    }

    handle(message: CellCommand, entry: Entry, box: EchoBox) {
        type HT = (m: CellCommand, entry: Entry, box: EchoBox) => void;
        const handler = this[`handle$${message.type}`];
        (handler as HT).call(this, message, entry, box);
    }

    handle$text(message: TextCommand, entry: Entry, box: EchoBox) {
        const existing = box.content;
        if (existing instanceof EmbeddedTerm) {
            existing.write(message.text);
            return;
        }
        const term = new EmbeddedTerm();
        // Ctrl-L (a bare ED 2 clear) drops the scrollback too, the way
        // `clear(1)` does (see the ed2-clears-scrollback attribute).
        term.setAttribute("ed2-clears-scrollback", "");
        entry.listeners.push((entry: Entry) => {
            const st = entry.cell.status.status;
            term.setCursorEnabled(st !== "done" && st !== "error");
        });
        box.setContent(term);
        // Dynamic sizing (rows grow with content) is the default, capped by
        // the box's max-height; a user drag pins the rows to the dragged
        // height, and double-clicking the bar frees it again. A box that is
        // its pane's whole content fills it, so with no drag height the grid
        // is pinned to the rendered cell height — the terminal spans the
        // whole pane (see the `echo-box[fills]` CSS). Boxes in a scroll
        // stream keep dynamic sizing.
        const fit = () => {
            const explicit = box.cellContentHeight;
            if (explicit !== null) {
                term.fit(explicit, box.maxContentHeight);
            } else if (box.hasAttribute("fills")) {
                const height = box.cellSize.height;
                term.fit(height > 0 ? height : null, box.maxContentHeight);
            } else {
                term.fit(null, box.maxContentHeight);
            }
        };
        box.addEventListener("resize", fit);
        fit();
        term.write(message.text);
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
    }

    // Answers a request the GUI itself made (`buche.request`); it does not
    // bring the GUI into existence (the request could only come from one).
    handle$response(message: ResponseCommand, entry: Entry, box: EchoBox) {
        const gui = box.content;
        if (gui instanceof BucheGui) {
            gui.send(message);
        }
    }
}
