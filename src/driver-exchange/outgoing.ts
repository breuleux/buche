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
}

export interface ParseRequest extends BaseRequest {
    type: "parse";
    text: string;
    position: number;
}

export interface SignalRequest extends BaseRequest {
    type: "signal";
    code: number;
}

export type SyncRequest = SyncMessage;

/** Union of every message type. */
export type OutgoingDriverMessage =
    | ParseRequest
    | CommandRequest
    | SignalRequest
    | SyncRequest;
