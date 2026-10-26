// @vitest-environment node
// Hashed libraries (src/library.ts): the store, the registry, and a driver
// declaring a library and supplying its files through Drivers.

import { mkdtempSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { InM } from "../src/core.ts";
import { Drivers } from "../src/drivers.ts";
import {
    DEFAULT_STORE_LIMIT,
    defaultStoreLimit,
    type LibraryAuthority,
    LibraryRegistry,
    LibraryStore,
    normalizeLibraryPath,
    sha256,
} from "../src/library.ts";

const ID = "0123456789abcdef0123";
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array | string) => (typeof b === "string" ? b : new TextDecoder().decode(b));

function tempStore(): LibraryStore {
    return new LibraryStore(join(mkdtempSync(join(tmpdir(), "buche-lib-")), "store"));
}

/** An authority supplying `contents`, counting the fetches. */
function authority(...contents: string[]): LibraryAuthority & { fetches: number } {
    const byHash = new Map(contents.map((c) => [sha256(enc(c)), enc(c)]));
    const a = {
        fetches: 0,
        async fetch(hash: string) {
            a.fetches++;
            const data = byHash.get(hash);
            if (!data) {
                throw new Error("unknown");
            }
            return data;
        },
    };
    return a;
}

const file = (content: string, mimetype = "text/javascript") => ({
    hash: sha256(enc(content)),
    mimetype,
});

describe("normalizeLibraryPath", () => {
    test("canonical forms", () => {
        expect(normalizeLibraryPath("a/b.js")).toBe("a/b.js");
        expect(normalizeLibraryPath("/a/b.js")).toBe("a/b.js");
    });

    test.each(["", "/", "a//b", "a/./b", "../a", "a/..", "a/", "a\\b", "a\0b"])(
        "rejects %j",
        (path) => {
            expect(normalizeLibraryPath(path)).toBeNull();
        },
    );
});

describe("LibraryStore", () => {
    test("round trip, private and atomic", async () => {
        const store = tempStore();
        const data = enc("hello");
        const hash = sha256(data);
        expect(await store.read(hash)).toBeNull();
        await store.write(hash, data);
        expect(dec((await store.read(hash)) as Uint8Array)).toBe("hello");
        expect(statSync(store.dir).mode & 0o777).toBe(0o700);
        expect(statSync(join(store.dir, hash)).mode & 0o777).toBe(0o600);
        expect(readdirSync(store.dir)).toEqual([hash]);
    });

    test("refuses content that does not match its hash", async () => {
        const store = tempStore();
        await expect(store.write(sha256(enc("a")), enc("b"))).rejects.toThrow();
    });

    test("evicts the entries used longest ago past its limit", async () => {
        const dir = join(mkdtempSync(join(tmpdir(), "buche-lib-")), "store");
        const store = new LibraryStore(dir, 25);
        const put = async (s: string, at: number, pinned?: (h: string) => boolean) => {
            const hash = sha256(enc(s));
            await store.write(hash, enc(s), pinned);
            // Pretend it was last used at `at` (seconds since the epoch).
            utimesSync(join(dir, hash), at, at);
            return hash;
        };
        const a = await put("a".repeat(10), 1000);
        const b = await put("b".repeat(10), 2000);
        // Using `a` makes `b` the oldest...
        expect(await store.read(a)).not.toBeNull();
        // ...so `b` goes when `c` brings the total to 30 > 25.
        const c = await put("c".repeat(10), 3000);
        expect(readdirSync(dir).sort()).toEqual([a, c].sort());
        expect(readdirSync(dir)).not.toContain(b);

        // Pinned entries stay, even past the limit; the new one always does.
        const d = await put("d".repeat(10), 4000, (h) => h === a);
        expect(readdirSync(dir).sort()).toEqual([a, d].sort());
        await put("e".repeat(30), 5000, () => true);
        expect(readdirSync(dir)).toHaveLength(3);
    });

    test("leftover temp files are cleaned up", async () => {
        const store = tempStore();
        await store.write(sha256(enc("x")), enc("x"));
        const stale = join(store.dir, ".deadbeef.123.abcd");
        writeFileSync(stale, "partial");
        utimesSync(stale, 1000, 1000);
        writeFileSync(join(store.dir, ".fresh.123.abcd"), "partial");
        await store.write(sha256(enc("y")), enc("y"));
        expect(readdirSync(store.dir)).toContain(".fresh.123.abcd");
        expect(readdirSync(store.dir)).not.toContain(".deadbeef.123.abcd");
    });

    test.each([
        [undefined, DEFAULT_STORE_LIMIT],
        ["1000", 1000],
        ["2K", 2048],
        ["1.5M", 1.5 * 1024 ** 2],
        ["1GiB", 1024 ** 3],
        ["lots", DEFAULT_STORE_LIMIT],
    ])("BUCHE_LIB_STORE_LIMIT=%j", (value, limit) => {
        const saved = process.env.BUCHE_LIB_STORE_LIMIT;
        try {
            if (value === undefined) {
                delete process.env.BUCHE_LIB_STORE_LIMIT;
            } else {
                process.env.BUCHE_LIB_STORE_LIMIT = value;
            }
            expect(defaultStoreLimit()).toBe(limit);
        } finally {
            if (saved === undefined) {
                delete process.env.BUCHE_LIB_STORE_LIMIT;
            } else {
                process.env.BUCHE_LIB_STORE_LIMIT = saved;
            }
        }
    });

    test("drops a damaged entry", async () => {
        const store = tempStore();
        const hash = sha256(enc("good"));
        await store.write(hash, enc("good"));
        writeFileSync(join(store.dir, hash), "bad");
        expect(await store.read(hash)).toBeNull();
        expect(readdirSync(store.dir)).toEqual([]);
    });
});

describe("LibraryRegistry", () => {
    test("serves declared files, fetching each content once", async () => {
        const registry = new LibraryRegistry(tempStore());
        const auth = authority("main();", "util();");
        expect(
            registry.declare(
                ID,
                { "main.js": file("main();"), "/lib/util.js": file("util();") },
                auth,
            ),
        ).toBeNull();

        const r = await registry.serve(ID, "/main.js");
        expect(r.status).toBe(200);
        expect(r.mimetype).toBe("text/javascript");
        expect(dec(r.body)).toBe("main();");
        expect(dec((await registry.serve(ID, "/lib/util.js")).body)).toBe("util();");
        expect(auth.fetches).toBe(2);

        // From the store from now on.
        await registry.serve(ID, "/main.js");
        expect(auth.fetches).toBe(2);
    });

    test("the store outlives the authority, and is shared by registries", async () => {
        const store = tempStore();
        const first = new LibraryRegistry(store);
        first.declare(ID, { "a.js": file("a") }, authority("a"));
        await first.serve(ID, "/a.js");

        const second = new LibraryRegistry(store);
        const gone: LibraryAuthority = { fetch: () => Promise.reject(new Error("gone")) };
        second.declare("another-library-id-0001", { "x.js": file("a") }, gone);
        const r = await second.serve("another-library-id-0001", "/x.js");
        expect(r.status).toBe(200);
        expect(dec(r.body)).toBe("a");
    });

    test("concurrent requests share one fetch", async () => {
        const registry = new LibraryRegistry(tempStore());
        const auth = authority("a");
        registry.declare(ID, { "a.js": file("a"), "b.js": file("a") }, auth);
        await Promise.all([
            registry.serve(ID, "/a.js"),
            registry.serve(ID, "/a.js"),
            registry.serve(ID, "/b.js"),
        ]);
        expect(auth.fetches).toBe(1);
    });

    test("unknown libraries and paths are not found", async () => {
        const registry = new LibraryRegistry(tempStore());
        registry.declare(ID, { "a.js": file("a") }, authority("a"));
        expect((await registry.serve("nope-nope-nope-nope", "/a.js")).status).toBe(404);
        expect((await registry.serve(ID, "/b.js")).status).toBe(404);
        expect((await registry.serve(ID, "/../a.js")).status).toBe(404);
        expect((await registry.serve(ID, "/%E0%A4%A")).status).toBe(400);
    });

    test("paths are percent-decoded", async () => {
        const registry = new LibraryRegistry(tempStore());
        registry.declare(ID, { "a b.js": file("a") }, authority("a"));
        expect((await registry.serve(ID, "/a%20b.js")).status).toBe(200);
    });

    test("content that does not match its hash is refused", async () => {
        const registry = new LibraryRegistry(tempStore());
        const liar: LibraryAuthority = { fetch: async () => enc("evil") };
        registry.declare(ID, { "a.js": file("a") }, liar);
        expect((await registry.serve(ID, "/a.js")).status).toBe(502);
    });

    test("an id is bound to its files", () => {
        const registry = new LibraryRegistry(tempStore());
        const a = authority("a");
        expect(registry.declare(ID, { "a.js": file("a") }, a)).toBeNull();
        expect(registry.declare(ID, { "a.js": file("b") }, a)).toMatch(/already declared/);
        expect(registry.declare(ID, { "a.js": file("a", "text/html") }, a)).toMatch(
            /already declared/,
        );
        // The same files again: accepted (one more authority to ask).
        expect(registry.declare(ID, { "/a.js": file("a") }, authority("a"))).toBeNull();
    });

    test("the files of its libraries are pinned in the store", async () => {
        const store = new LibraryStore(join(mkdtempSync(join(tmpdir(), "buche-lib-")), "s"), 1);
        const registry = new LibraryRegistry(store);
        registry.declare(ID, { "a.js": file("a"), "b.js": file("b") }, authority("a", "b"));
        await registry.serve(ID, "/a.js");
        await registry.serve(ID, "/b.js");
        // Way past the limit, but both stay: the authority could be gone.
        expect(readdirSync(store.dir)).toHaveLength(2);
    });

    test("inline content needs no authority", async () => {
        const registry = new LibraryRegistry(tempStore());
        const nobody: LibraryAuthority = { fetch: () => Promise.reject(new Error("nobody")) };
        expect(
            registry.declare(
                ID,
                {
                    "a.js": { mimetype: "text/javascript", content: "a();" },
                    "b.bin": {
                        mimetype: "application/octet-stream",
                        content: Buffer.from([0, 255]).toString("base64"),
                        encoding: "base64",
                    },
                    // Mixed with a file the authority supplies (here, can't).
                    "c.js": file("c"),
                },
                nobody,
            ),
        ).toBeNull();
        expect(dec((await registry.serve(ID, "/a.js")).body)).toBe("a();");
        expect([...((await registry.serve(ID, "/b.bin")).body as Uint8Array)]).toEqual([0, 255]);
        expect((await registry.serve(ID, "/c.js")).status).toBe(502);
    });

    test("inline content must match a given hash", () => {
        const registry = new LibraryRegistry(tempStore());
        expect(
            registry.declare(
                ID,
                { "a.js": { hash: sha256(enc("b")), mimetype: "text/plain", content: "a" } },
                authority(),
            ),
        ).toMatch(/does not match/);
        // A matching one is fine, and the same files as a hash-only entry.
        expect(
            registry.declare(
                ID,
                { "a.js": { hash: sha256(enc("a")), mimetype: "text/plain", content: "a" } },
                authority(),
            ),
        ).toBeNull();
        expect(registry.declare(ID, { "a.js": file("a", "text/plain") }, authority())).toBeNull();
    });

    test("a re-declaring authority is a fallback", async () => {
        const registry = new LibraryRegistry(tempStore());
        const gone: LibraryAuthority = { fetch: () => Promise.reject(new Error("gone")) };
        registry.declare(ID, { "a.js": file("a") }, gone);
        registry.declare(ID, { "a.js": file("a") }, authority("a"));
        expect((await registry.serve(ID, "/a.js")).status).toBe(200);
    });

    test.each([
        ["short", { "a.js": file("a") }],
        ["UPPERCASE-UPPERCASE", { "a.js": file("a") }],
        [ID, { "../a.js": file("a") }],
        [ID, { "a.js": { hash: "xyz", mimetype: "text/plain" } }],
        [ID, { "a.js": file("a"), "/a.js": file("a") }],
    ])("refuses the declaration %j %j", (id, files) => {
        const registry = new LibraryRegistry(tempStore());
        expect(registry.declare(id, files, authority("a"))).not.toBeNull();
    });
});

describe("Drivers", () => {
    // A driver declaring a library and answering library_fetch from a map.
    const driverScript = (files: Record<string, string>) => `
        const crypto = require("node:crypto");
        const net = require("node:net");
        const files = ${JSON.stringify(files)};
        const sock = new net.Socket({ fd: 5 });
        const send = (m) => sock.write(JSON.stringify(m) + "\\n");
        const byHash = {};
        const decl = {};
        for (const [path, content] of Object.entries(files)) {
            const hash = crypto.createHash("sha256").update(content).digest("hex");
            byHash[hash] = content;
            decl[path] = { hash, mimetype: "text/plain" };
        }
        send({ type: "library", from: ["$proc"], to: ["$term"], id: "${ID}", files: decl });
        send({ type: "library", from: ["$proc"], to: ["$term"], id: "bad", files: {} });
        let buf = "";
        sock.on("data", (d) => {
            buf += d;
            let nl;
            while ((nl = buf.indexOf("\\n")) >= 0) {
                const m = JSON.parse(buf.slice(0, nl));
                buf = buf.slice(nl + 1);
                if (m.type !== "library_fetch") continue;
                const content = byHash[m.hash];
                send(content === undefined
                    ? { type: "library_content", from: ["$proc"], to: ["$term"], request_id: m.request_id, error: "nope" }
                    : { type: "library_content", from: ["$proc"], to: ["$term"], request_id: m.request_id,
                        content: Buffer.from(content).toString("base64"), encoding: "base64" });
            }
        });
    `;

    test("a driver that answers nothing can declare inline files", async () => {
        const registry = new LibraryRegistry(tempStore());
        const received: InM[] = [];
        const drivers = new Drivers({ libraries: registry, receive: (m) => received.push(m) });
        const decl = {
            type: "library",
            from: ["$proc"],
            to: ["$term"],
            id: ID,
            files: { "index.html": { mimetype: "text/html", content: "<p>inline</p>" } },
        };
        const proc = drivers.start([
            process.execPath,
            "-e",
            `require("node:fs").writeSync(5, ${JSON.stringify(`${JSON.stringify(decl)}\n`)})`,
        ] as unknown as string);
        await proc.exited;
        await expect
            .poll(async () => (await registry.serve(ID, "/index.html")).status, { timeout: 5000 })
            .toBe(200);
        expect(dec((await registry.serve(ID, "/index.html")).body)).toBe("<p>inline</p>");
        expect(received.filter((m) => m.type === "error")).toEqual([]);
    });

    test("a driver declares a library and supplies its files", async () => {
        const registry = new LibraryRegistry(tempStore());
        const received: InM[] = [];
        const drivers = new Drivers({ libraries: registry, receive: (m) => received.push(m) });
        const proc = drivers.start([
            process.execPath,
            "-e",
            driverScript({ "index.html": "<p>hi</p>" }),
        ] as unknown as string);
        try {
            // The declaration is taken in; the bad one is reported.
            await expect
                .poll(() => received.find((m) => m.type === "error"), { timeout: 5000 })
                .toMatchObject({ error_type: "library" });
            expect(received.some((m) => m.type === "library")).toBe(false);

            const r = await registry.serve(ID, "/index.html");
            expect(r.status).toBe(200);
            expect(dec(r.body)).toBe("<p>hi</p>");
        } finally {
            proc.kill();
            await proc.exited;
        }
        // Gone, but stored.
        expect((await registry.serve(ID, "/index.html")).status).toBe(200);
    });
});
