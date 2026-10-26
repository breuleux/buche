import type { Buche } from "../core.ts";
import type { BaseMessage } from "./common.ts";

/**
 * The answer to a `library_fetch` request: the content of a library file,
 * or why it can't be had (the file is gone, or changed since it was
 * declared). Handled by the host running the drivers (src/drivers.ts).
 */
export interface LibraryContentMessage extends BaseMessage {
    type: "library_content";

    /** The `request_id` of the `library_fetch` this answers. */
    request_id: string;

    /** The content, encoded as `encoding` says (absent on error). */
    content?: string;

    /** Encoding of `content`; defaults to `"base64"`. */
    encoding?: "base64" | "utf-8";

    /** Why the content can't be supplied. */
    error?: string;
}

// The host (src/drivers.ts) takes these on the way in (see _library.ts).
export function handle$library_content(_buche: Buche, _obj: LibraryContentMessage): void {}
