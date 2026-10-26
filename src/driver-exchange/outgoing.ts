import type { SyncMessage } from "./_sync.ts";
import type { Action, Address, Json, Selection } from "./common.ts";

export interface BaseRequest {
    type: string;
    from: Address;
    to: Address;
}

export interface CommandRequest extends BaseRequest {
    type: "command";

    /** The prompt's text when the command fired (empty: fired elsewhere, see
     *  `anchor`). */
    text: string;

    /** The prompt's selection when the command fired. */
    selection: Selection;

    /** The action that fired: a key binding's, or a clicked part's. */
    action: Action;

    /**
     * Identifies this command. A driver that produces an echo in response
     * repeats it as the echo's `id`, so the terminal can relate the two (e.g.
     * to focus the new cell).
     */
    id?: string;

    /**
     * Where what the command shows goes (a zone, as in `@zone cmd`), when the
     * terminal decided it (e.g. a slot the user picked it for).
     */
    zone?: string;

    /**
     * Where the command was performed, when not in the prompt: the address of
     * the cell an inherited binding fired in (see `inherit` on actions). What
     * the command shows is meant to go relative to it: pass it on as the
     * `anchor` of what it configures.
     */
    anchor?: Address;
}

export interface ParseRequest extends BaseRequest {
    type: "parse";
    text: string;

    /** The prompt's selection when the parse was requested (`start === end`
     *  is the plain cursor position). */
    selection: Selection;

    /**
     * Reference number for this parse. Whatever answers it — the highlight
     * echo (a prompt `configure` carrying `request_id`) — repeats it, so the
     * machine can drop answers to superseded inputs (the user typed on in
     * the meantime).
     */
    request_id: string;
}

export interface SignalRequest extends BaseRequest {
    type: "signal";
    code: number;
}

/**
 * Run the process the cell at `to` shows again, from the start: as it was
 * first run (same command, working directory and environment), in the same
 * cells, reset (see `reset`). If it still runs, it is ended first. Which
 * process that is, the drivers on the way decide: e.g. a shell reruns a
 * process it runs for the cells it made for it (`$stdout`, `$frame`...), and
 * passes the request on to the process for its own cells (unless the process
 * left them to the shell). An address that can't be run again (nothing ran
 * there, a builtin, or too long ago) is ignored.
 */
export interface RerunRequest extends BaseRequest {
    type: "rerun";
}

/**
 * Start another driver (a shell), at the address `to` (one segment, e.g.
 * `["$d1"]`): its messages come with their addresses under it, and messages
 * to addresses under it go to it. For the host running the drivers, not for a
 * driver: it starts `command`, in the terminal's working directory.
 */
export interface SpawnRequest extends BaseRequest {
    type: "spawn";
    command: string;
}

export interface TextRequest extends BaseRequest {
    type: "text";

    /** Stream the text is delivered on (keyboard input from the interface). */
    stream: "stdin";

    /** Raw input text, as produced by the terminal emulator. */
    text: string;
}

export interface DataRequest extends BaseRequest {
    type: "data";

    /** Arbitrary JSON relayed from the interface (a GUI cell message, a
     *  `proc://` request, an exec response, ...). */
    data: Json;
}

export interface ResizeRequest extends BaseRequest {
    type: "resize";

    /** The cell's content area, in CSS pixels. */
    pixel: {
        height: number;
        width: number;
    };

    /** The terminal grid, in character cells, when the cell holds a pty. */
    pty?: {
        height: number;
        width: number;
    };
}

/**
 * Ask a library's authority (the driver that declared it, see `library`) for
 * the content of one of its files, by hash. Sent by the host, addressed to
 * the driver itself (`["$proc"]`); answered by a `library_content` carrying
 * the same `request_id`.
 */
export interface LibraryFetchRequest extends BaseRequest {
    type: "library_fetch";

    /** Repeated by the `library_content` answer. */
    request_id: string;

    /** SHA-256 of the content wanted, lowercase hex. */
    hash: string;
}

// UNUSED: see `sync` (driver-exchange/_sync.ts).
export type SyncRequest = SyncMessage;

/** Union of every message type. */
export type OutgoingDriverMessage =
    | ParseRequest
    | CommandRequest
    | SignalRequest
    | RerunRequest
    | SpawnRequest
    | TextRequest
    | DataRequest
    | ResizeRequest
    | LibraryFetchRequest
    | SyncRequest;
