import type { SyncMessage } from "./_sync.ts";

export type SyncResponse = SyncMessage;

/** Union of every message type. */
export type OutgoingDriverMessage = SyncResponse;
