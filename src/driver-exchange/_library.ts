import type { Buche } from "../core.ts";
import type { BaseMessage } from "./common.ts";

/**
 * A file of a declared library (see {@link LibraryMessage}): its hash, the
 * authority (the declaring driver) supplying the content on request; or its
 * content itself, which needs no authority.
 */
export interface LibraryFile {
    /** SHA-256 of the file's content, lowercase hex. Required without
     *  `content`; checked against it otherwise. */
    hash?: string;

    /** MIME type the file is served with. */
    mimetype: string;

    /** The content, inline, encoded as `encoding` says. */
    content?: string;

    /** Encoding of `content`; defaults to `"utf-8"`. */
    encoding?: "utf-8" | "base64";
}

/**
 * Declare a library: files served to GUI cells at `lib://<id>/<path>`, which
 * can reference each other by relative URLs. The driver sending it is the
 * library's authority: it vouches for the files (a shell checks that the
 * process declaring them could read them), and supplies their content on
 * request (`library_fetch`, answered by `library_content`) — except for the
 * files whose content comes with the declaration. See src/library.ts.
 *
 * Handled by the host running the drivers (src/drivers.ts), not the terminal.
 */
export interface LibraryMessage extends BaseMessage {
    type: "library";

    /**
     * The library's id, the host part of its URLs: 16 to 63 characters in
     * `[a-z0-9-]`. Whoever knows it can load the library, so it must be
     * unguessable. An id is bound to its files: declaring it again with
     * different files is refused.
     */
    id: string;

    /** The files, by path in the library (e.g. `"js/main.js"`). */
    files: Record<string, LibraryFile>;
}

// The host (src/drivers.ts) takes these on the way in; one reaching the
// terminal means no host is serving libraries (e.g. a test harness).
export function handle$library(_buche: Buche, obj: LibraryMessage): void {
    console.warn(`[buche] library ${obj.id} declared, but nothing serves lib:// here`);
}
