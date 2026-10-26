// Hashed libraries: groups of files served to GUI cells at `lib://<id>/<path>`.
//
// A process declares a library to its shell (cq), listing each file with
// a proof that it could read it (an HMAC of the content keyed by a salt cq
// gave that process only). The shell checks the proofs against the files,
// and forwards the declaration here with the plain SHA-256 of each file in
// place of the proof (a `library` driver message). From then on the shell is
// the library's *authority*: when a file isn't in the store yet, it is asked
// for its content (a `library_fetch` request, answered by `library_content`),
// which it reads again and checks against the hash. The process itself never
// has to send the content, and may be gone by the time it is needed.
//
//   process ──library{id, files: {path: {file, mimetype, proof}}}──▶ cq
//        cq ──library{id, files: {path: {hash, mimetype}}}──▶ buche (Drivers)
//     buche ──library_fetch{request_id, hash}──▶ cq
//        cq ──library_content{request_id, content, encoding}──▶ buche
//
// For simplicity, a file may also come with its content, inline, in place of
// its file and proof (or its hash): `{mimetype, content, encoding}`. Sending
// the content is proof enough, and no authority is needed for it — a program
// declaring only such files needs no shell at all.
//
// Contents are kept in a store on disk keyed by their SHA-256 (see
// LibraryStore), shared by every session and every buche instance: a file
// only crosses the control channel once, and a library keeps loading after
// its process (and even its shell) is gone, as long as its files are stored.
//
// The id is chosen by the process. It is the capability: whoever knows it can
// load the library, so it must be unguessable (≥ 16 characters; a random one,
// or one derived from the proofs, which only someone able to read the files
// can compute). An id is bound to its files for good: declaring it again with
// different files is refused, so a known id can't be hijacked.
//
// Node-only (the hosts: electron/main.ts, scripts/view.ts, through Drivers).

import { createHash, randomBytes } from "node:crypto";
import {
    mkdir,
    readdir,
    readFile,
    rename,
    stat,
    unlink,
    utimes,
    writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** A file of a library, as the authority vouches for it. */
export interface LibraryFileEntry {
    /** SHA-256 of the content, lowercase hex. */
    hash: string;
    /** MIME type the file is served with. */
    mimetype: string;
}

/** A file as declared: its hash, or its content inline (see LibraryFile in
 *  driver-exchange/_library.ts). */
export interface DeclaredLibraryFile {
    hash?: string;
    mimetype: string;
    content?: string;
    encoding?: "utf-8" | "base64";
}

/** Whoever can supply the content of a library's files (a driver). */
export interface LibraryAuthority {
    /** The content whose SHA-256 is `hash`; rejects if it can't. */
    fetch(hash: string): Promise<Uint8Array>;
}

/** What a `lib://` request gets. */
export interface LibraryResponse {
    status: number;
    body: Uint8Array | string;
    mimetype: string;
}

/** A library id: one lowercase hostname label, long enough to be a secret. */
export const LIBRARY_ID = /^[a-z0-9][a-z0-9-]{15,62}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export function sha256(data: Uint8Array): string {
    return createHash("sha256").update(data).digest("hex");
}

/**
 * The canonical form of a path in a library ("a/b.js"), or null if it is not
 * acceptable: no empty, `.` or `..` segments, no backslashes or NULs. A
 * leading slash is dropped, so URL paths and manifest keys compare equal.
 */
export function normalizeLibraryPath(path: string): string | null {
    const segments = path.replace(/^\/+/, "").split("/");
    if (
        segments.some(
            (s) => s === "" || s === "." || s === ".." || s.includes("\\") || s.includes("\0"),
        )
    ) {
        return null;
    }
    return segments.join("/");
}

/** Where the store lives: $BUCHE_LIB_STORE, else $XDG_CACHE_HOME/buche/lib. */
export function defaultStoreDir(): string {
    const env = process.env;
    return (
        env.BUCHE_LIB_STORE ||
        join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "buche", "lib")
    );
}

/** The store's default size limit: 512 MiB. */
export const DEFAULT_STORE_LIMIT = 512 * 1024 * 1024;

/** The store's size limit, in bytes: $BUCHE_LIB_STORE_LIMIT (a number of
 *  bytes, or with a K/M/G suffix), else {@link DEFAULT_STORE_LIMIT}. */
export function defaultStoreLimit(): number {
    const match = /^\s*(\d+(?:\.\d+)?)\s*([kmg]?)i?b?\s*$/i.exec(
        process.env.BUCHE_LIB_STORE_LIMIT ?? "",
    );
    if (!match) {
        return DEFAULT_STORE_LIMIT;
    }
    const unit = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[match[2].toLowerCase()] ?? 1;
    return Math.floor(Number(match[1]) * unit);
}

/** Temp files older than this are leftovers of interrupted writes. */
const STALE_TEMP_AGE = 60 * 60 * 1000;

/**
 * Library contents on disk, one file per content, named by its SHA-256. The
 * directory is private (0700): it holds copies of files some process proved
 * it could read, and must not be readable by anyone who couldn't.
 *
 * Writes are atomic (temp file, then rename), so several buche instances can
 * share the store; reads are checked against the name, and a damaged entry is
 * dropped.
 *
 * The store is kept under `limit` bytes: after each write, the entries used
 * longest ago go first. An entry's mtime is the time it was last used (set on
 * every read; atimes can't be relied on). Entries the caller pins (those of
 * the libraries it serves, which their authorities may no longer be able to
 * supply) are kept even past the limit.
 */
export class LibraryStore {
    /** Evictions, one at a time. */
    private evicting: Promise<void> = Promise.resolve();

    constructor(
        readonly dir: string = defaultStoreDir(),
        readonly limit: number = defaultStoreLimit(),
    ) {}

    async read(hash: string): Promise<Uint8Array | null> {
        if (!SHA256_HEX.test(hash)) {
            return null;
        }
        const file = join(this.dir, hash);
        let data: Uint8Array;
        try {
            data = await readFile(file);
        } catch {
            return null;
        }
        if (sha256(data) !== hash) {
            await unlink(file).catch(() => {});
            return null;
        }
        // Used now: last in line for eviction.
        const now = new Date();
        await utimes(file, now, now).catch(() => {});
        return data;
    }

    /** Store `data` (whose SHA-256 is `hash`), then bring the store back
     *  under its limit, sparing the entries `pinned` says to keep. */
    async write(
        hash: string,
        data: Uint8Array,
        pinned: (hash: string) => boolean = () => false,
    ): Promise<void> {
        if (!SHA256_HEX.test(hash) || sha256(data) !== hash) {
            throw new Error(`library store: content does not match ${hash}`);
        }
        await mkdir(this.dir, { recursive: true, mode: 0o700 });
        const tmp = join(this.dir, `.${hash}.${process.pid}.${randomBytes(4).toString("hex")}`);
        await writeFile(tmp, data, { mode: 0o600 });
        try {
            await rename(tmp, join(this.dir, hash));
        } catch (err) {
            await unlink(tmp).catch(() => {});
            throw err;
        }
        const evict = this.evicting.then(() => this.evict((h) => h === hash || pinned(h)));
        this.evicting = evict.catch(() => {});
        await evict;
    }

    /** Remove the entries used longest ago until the store fits its limit
     *  (and leftover temp files). */
    private async evict(pinned: (hash: string) => boolean): Promise<void> {
        const now = Date.now();
        const entries: { hash: string; size: number; used: number }[] = [];
        let total = 0;
        for (const name of await readdir(this.dir)) {
            const file = join(this.dir, name);
            const info = await stat(file).catch(() => null);
            if (!info?.isFile()) {
                continue;
            }
            if (SHA256_HEX.test(name)) {
                entries.push({ hash: name, size: info.size, used: info.mtimeMs });
                total += info.size;
            } else if (name.startsWith(".") && now - info.mtimeMs > STALE_TEMP_AGE) {
                await unlink(file).catch(() => {});
            }
        }
        entries.sort((a, b) => a.used - b.used);
        for (const entry of entries) {
            if (total <= this.limit) {
                break;
            }
            if (pinned(entry.hash)) {
                continue;
            }
            await unlink(join(this.dir, entry.hash)).catch(() => {});
            total -= entry.size;
        }
    }
}

interface Library {
    files: Map<string, LibraryFileEntry>;
    /** Who can supply the files, in order of preference: whoever declared the
     *  library first, then whoever declared it again (the same files). */
    authorities: LibraryAuthority[];
}

/** The libraries declared to a host, and the content behind them. */
export class LibraryRegistry {
    private libraries = new Map<string, Library>();
    /** Content being fetched, by hash, so that concurrent requests share it. */
    private inflight = new Map<string, Promise<Uint8Array>>();
    /** The hashes of every file of the libraries declared here: never evicted
     *  from the store by this registry, since their authorities may be gone
     *  (and with them, the only other way to get the content). */
    private pinned = new Set<string>();

    constructor(readonly store: LibraryStore = new LibraryStore()) {}

    /**
     * Declare library `id` with `files` (path → entry), supplied by
     * `authority`. Returns an error message if the declaration is refused.
     */
    declare(
        id: string,
        files: Record<string, DeclaredLibraryFile>,
        authority: LibraryAuthority,
    ): string | null {
        if (!LIBRARY_ID.test(id)) {
            return `invalid library id ${JSON.stringify(id)} (expected 16 to 63 characters in [a-z0-9-])`;
        }
        const map = new Map<string, LibraryFileEntry>();
        const inline = new Map<string, Uint8Array>();
        for (const [rawPath, entry] of Object.entries(files)) {
            const path = normalizeLibraryPath(rawPath);
            if (path === null) {
                return `library ${id}: invalid path ${JSON.stringify(rawPath)}`;
            }
            let hash = entry.hash;
            if (entry.content !== undefined) {
                const data = Buffer.from(
                    entry.content,
                    entry.encoding === "base64" ? "base64" : "utf8",
                );
                const actual = sha256(data);
                if (hash !== undefined && hash !== actual) {
                    return `library ${id}: the content of ${JSON.stringify(rawPath)} does not match its hash`;
                }
                hash = actual;
                inline.set(hash, data);
            }
            if (hash === undefined || !SHA256_HEX.test(hash)) {
                return `library ${id}: invalid hash for ${JSON.stringify(rawPath)}`;
            }
            if (map.has(path)) {
                return `library ${id}: duplicate path ${JSON.stringify(path)}`;
            }
            map.set(path, { hash, mimetype: entry.mimetype });
        }
        const existing = this.libraries.get(id);
        if (existing) {
            if (!sameFiles(existing.files, map)) {
                return `library ${id} is already declared, with different files`;
            }
            if (inline.size > 0) {
                existing.authorities.unshift(new InlineAuthority(inline));
            }
            if (!existing.authorities.includes(authority)) {
                existing.authorities.push(authority);
            }
            return null;
        }
        // Inline contents are kept at hand, ahead of the declaring driver: the
        // store is a cache, which other buche instances may evict from.
        const authorities =
            inline.size > 0 ? [new InlineAuthority(inline), authority] : [authority];
        this.libraries.set(id, { files: map, authorities });
        for (const entry of map.values()) {
            this.pinned.add(entry.hash);
        }
        return null;
    }

    /** Answer a request for `lib://<id><urlPath>` (`urlPath` still encoded). */
    async serve(id: string, urlPath: string): Promise<LibraryResponse> {
        const notFound: LibraryResponse = {
            status: 404,
            body: "not found",
            mimetype: "text/plain",
        };
        const library = this.libraries.get(id);
        if (!library) {
            return notFound;
        }
        let decoded: string;
        try {
            decoded = urlPath.split("/").map(decodeURIComponent).join("/");
        } catch {
            return { status: 400, body: "bad path", mimetype: "text/plain" };
        }
        const path = normalizeLibraryPath(decoded);
        const entry = path === null ? undefined : library.files.get(path);
        if (!entry) {
            return notFound;
        }
        try {
            const body = await this.content(entry.hash, library.authorities);
            return { status: 200, body, mimetype: entry.mimetype };
        } catch (err) {
            return {
                status: 502,
                body: `could not obtain ${path}: ${(err as Error)?.message ?? err}`,
                mimetype: "text/plain",
            };
        }
    }

    /** The content for `hash`: from the store, else from an authority (and
     *  then stored). */
    private content(hash: string, authorities: LibraryAuthority[]): Promise<Uint8Array> {
        let pending = this.inflight.get(hash);
        if (!pending) {
            pending = this.obtain(hash, authorities).finally(() => this.inflight.delete(hash));
            this.inflight.set(hash, pending);
        }
        return pending;
    }

    private async obtain(hash: string, authorities: LibraryAuthority[]): Promise<Uint8Array> {
        const stored = await this.store.read(hash);
        if (stored) {
            return stored;
        }
        let lastError: unknown = new Error("no authority");
        for (const authority of authorities) {
            let data: Uint8Array;
            try {
                data = await authority.fetch(hash);
            } catch (err) {
                lastError = err;
                continue;
            }
            if (sha256(data) !== hash) {
                lastError = new Error("content does not match its hash");
                continue;
            }
            // The store is a cache: failing to write to it only costs a refetch.
            await this.store
                .write(hash, data, (h) => this.pinned.has(h))
                .catch((err) => {
                    console.error("[buche] library store:", err);
                });
            return data;
        }
        throw lastError;
    }
}

/** The contents that came with a declaration. */
class InlineAuthority implements LibraryAuthority {
    constructor(private contents: Map<string, Uint8Array>) {}

    async fetch(hash: string): Promise<Uint8Array> {
        const data = this.contents.get(hash);
        if (!data) {
            throw new Error("not inline");
        }
        return data;
    }
}

function sameFiles(a: Map<string, LibraryFileEntry>, b: Map<string, LibraryFileEntry>): boolean {
    if (a.size !== b.size) {
        return false;
    }
    for (const [path, entry] of a) {
        const other = b.get(path);
        if (!other || other.hash !== entry.hash || other.mimetype !== entry.mimetype) {
            return false;
        }
    }
    return true;
}
