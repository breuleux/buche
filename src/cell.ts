import type { EchoBox } from "./components/echo-box.tsx";
import type { Entry } from "./entry.ts";
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
 * a group until it shows something; each kind has its class (in `cells/`),
 * and an entry changing kind gets a new cell (see `Entry.replaceCell`).
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

/** What an entry is and shows: its look, its status, and (by its kind) what
 *  it does with the commands it is sent. */
export abstract class Cell extends WithId() {
    /** What the cell is (see {@link CellKind}). */
    abstract readonly kind: CellKind;

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

    constructor(config: CellConfiguration = {}) {
        super();
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

    /** Take over the look and status of `prev`, the cell this one replaces
     *  (see `Entry.replaceCell`). */
    inherit(prev: Cell): this {
        this.submission = prev.submission;
        this.label = prev.label;
        this.color = prev.color;
        this.icon = prev.icon;
        this.id = prev.id;
        this.sticky = prev.sticky;
        this.background = prev.background;
        this.ephemeral = prev.ephemeral;
        this.status = prev.status;
        return this;
    }

    /** Whether the cell takes `command` (by default, it takes none). */
    accepts(command: CellCommand): boolean {
        return false;
    }

    /** Give the box the content the cell needs (idempotent: run on every
     *  update). By default, there is none. */
    initialize(entry: Entry, box: EchoBox): void {}

    /** Act on `command`, one the cell {@link accepts}. */
    handle(command: CellCommand, entry: Entry, box: EchoBox): void {}
}
