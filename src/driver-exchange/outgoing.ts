import type { SyncMessage } from "./_sync.ts";
import type { Address } from "./common.ts";

export interface CommandRequest {
    type: "command";
    from: Address;
    to: Address;
    text: string;
    position: number;
    command: string;
}

export interface ParseRequest {
    type: "parse";
    from: Address;
    to: Address;
    text: string;
    position: number;
}

export type SyncRequest = SyncMessage;

/** Union of every message type. */
export type OutgoingDriverMessage = ParseRequest | CommandRequest | SyncRequest;
