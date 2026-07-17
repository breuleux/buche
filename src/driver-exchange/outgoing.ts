import type { SyncMessage } from "./_sync.ts";
import type { Address } from "./common.ts";

export interface BaseRequest {
    type: string;
    from: Address;
    to: Address;
}

export interface CommandRequest extends BaseRequest {
    type: "command";
    text: string;
    position: number;
    command: string;

    /**
     * Identifies this command. A driver that produces an echo in response
     * repeats it as the echo's `id`, so the terminal can relate the two (e.g.
     * to focus the new cell).
     */
    id?: string;
}

export interface ParseRequest extends BaseRequest {
    type: "parse";
    text: string;
    position: number;

    /**
     * Reference number for this parse. Whatever answers it — the highlight
     * echo (a `prompt_configure` carrying `request_id`) — repeats it, so the
     * machine can drop answers to superseded inputs (the user typed on in
     * the meantime).
     */
    request_id: string;
}

export interface SignalRequest extends BaseRequest {
    type: "signal";
    code: number;
}

export interface TextRequest extends BaseRequest {
    type: "text";

    /** Stream the text is delivered on (keyboard input from the interface). */
    stream: "stdin";

    /** Raw input text, as produced by the terminal emulator. */
    text: string;
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

export type SyncRequest = SyncMessage;

/** Union of every message type. */
export type OutgoingDriverMessage =
    | ParseRequest
    | CommandRequest
    | SignalRequest
    | TextRequest
    | ResizeRequest
    | SyncRequest;
