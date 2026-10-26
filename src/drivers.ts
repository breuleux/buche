// The driver processes of a terminal (a window, a view session): the one it
// starts with, and the shells started later at the interface's request (a
// `spawn` message: see SpawnRequest), each at an address of its own.
//
// The first driver's addresses are its own. Another one's live under its
// address (`["$d1"]`...): what it sends comes back with `from` under it, and
// messages to addresses under it go to it, with
// the prefix taken off. A `signal` to a driver's `["$proc"]` kills it.
//
// The drivers' library declarations are taken here, on the way in, and go to
// the host's library registry, each driver being the authority for the
// libraries it declares (see src/library.ts).

import { randomUUID } from "node:crypto";
import type { InM } from "./core.ts";
import type { LibraryMessage } from "./driver-exchange/_library.ts";
import type { LibraryContentMessage } from "./driver-exchange/_library_content.ts";
import type {
    OutgoingDriverMessage,
    SignalRequest,
    SpawnRequest,
} from "./driver-exchange/outgoing.ts";
import type { LibraryAuthority, LibraryRegistry } from "./library.ts";
import { ProcessCommunicator, type ProcessCommunicatorOptions } from "./process.ts";
import type { Address } from "./types.ts";

/** How long a driver gets to supply a library file. */
const LIBRARY_FETCH_TIMEOUT = 10_000;

export interface DriversOptions {
    /** Where the drivers run. */
    cwd?: string;
    /** Each message from a driver, addresses rewritten. */
    receive(message: InM): void;
    /** Every driver has exited. */
    exited?(): void;
    /** Where the drivers' libraries are declared (none: `library` messages
     *  go through to `receive`, like any other). */
    libraries?: LibraryRegistry;
}

export class Drivers {
    private procs = new Map<string, ProcessCommunicator>();

    constructor(private options: DriversOptions) {}

    /** Start a driver (at the address `id`: "" for the first one's own). */
    start(
        command: string,
        id = "",
        options: ProcessCommunicatorOptions = {},
    ): ProcessCommunicator {
        const proc = new ProcessCommunicator(command, { cwd: this.options.cwd, ...options });
        this.procs.set(id, proc);
        const under = (addr: unknown): unknown =>
            id && Array.isArray(addr) ? [id, ...(addr as Address)] : addr;
        const authority = new DriverAuthority(proc);
        const libraries = this.options.libraries;
        void (async () => {
            try {
                for await (const message of proc.messages()) {
                    if (libraries && message.type === "library") {
                        const decl = message as LibraryMessage;
                        const error = libraries.declare(decl.id, decl.files, authority);
                        if (error) {
                            this.options.receive({
                                type: "error",
                                from: under(decl.from) as Address,
                                to: ["$term"],
                                error_type: "library",
                                message: error,
                            });
                        }
                        continue;
                    }
                    if (libraries && message.type === "library_content") {
                        authority.answer(message as LibraryContentMessage);
                        continue;
                    }
                    const m = message as unknown as Record<string, unknown>;
                    this.options.receive({ ...m, from: under(m.from) } as unknown as InM);
                }
            } catch (err) {
                console.error(`[buche] driver ${id || "(first)"}: stream error:`, err);
            }
        })();
        void proc.exited.then(() => {
            authority.close();
            this.procs.delete(id);
            if (this.procs.size === 0) {
                this.options.exited?.();
            }
        });
        return proc;
    }

    /** The first driver, if it is still there. */
    get first(): ProcessCommunicator | undefined {
        return this.procs.get("");
    }

    /** Send a message from the interface to the driver it's for. */
    send(message: OutgoingDriverMessage): void {
        if (message.type === "spawn") {
            const spawn = message as SpawnRequest;
            const id = spawn.to[0];
            if (id && !this.procs.has(id)) {
                this.start(spawn.command, id);
            }
            return;
        }
        const head = message.to[0];
        const id = head !== undefined && head !== "" && this.procs.has(head) ? head : "";
        const proc = this.procs.get(id);
        if (!proc) {
            return;
        }
        const to = id ? message.to.slice(1) : message.to;
        const signal = message as SignalRequest;
        if (message.type === "signal" && to.length === 1 && to[0] === "$proc") {
            proc.kill(signal.code);
        } else {
            proc.send({ ...message, to } as OutgoingDriverMessage);
        }
    }

    /** End every driver. */
    kill(): void {
        for (const proc of this.procs.values()) {
            proc.kill();
        }
    }
}

/** A driver, as the authority for the libraries it declares: asked for file
 *  contents with `library_fetch`, answering with `library_content`. */
class DriverAuthority implements LibraryAuthority {
    private pending = new Map<
        string,
        { resolve: (data: Uint8Array) => void; reject: (err: Error) => void }
    >();
    private closed = false;

    constructor(private proc: ProcessCommunicator) {}

    fetch(hash: string): Promise<Uint8Array> {
        if (this.closed) {
            return Promise.reject(new Error("the library's driver is gone"));
        }
        const request_id = randomUUID();
        return new Promise<Uint8Array>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(request_id);
                reject(new Error("the library's driver did not answer"));
            }, LIBRARY_FETCH_TIMEOUT);
            this.pending.set(request_id, {
                resolve: (data) => {
                    clearTimeout(timer);
                    resolve(data);
                },
                reject: (err) => {
                    clearTimeout(timer);
                    reject(err);
                },
            });
            try {
                this.proc.send({
                    type: "library_fetch",
                    from: ["$term"],
                    to: ["$proc"],
                    request_id,
                    hash,
                });
            } catch (err) {
                this.pending.get(request_id)?.reject(err as Error);
                this.pending.delete(request_id);
            }
        });
    }

    answer(message: LibraryContentMessage): void {
        const waiter = this.pending.get(message.request_id);
        if (!waiter) {
            return;
        }
        this.pending.delete(message.request_id);
        if (message.error !== undefined || message.content === undefined) {
            waiter.reject(new Error(message.error ?? "no content"));
        } else {
            waiter.resolve(
                Buffer.from(message.content, message.encoding === "utf-8" ? "utf8" : "base64"),
            );
        }
    }

    /** The driver exited: nothing more will be answered. */
    close(): void {
        this.closed = true;
        for (const waiter of this.pending.values()) {
            waiter.reject(new Error("the library's driver is gone"));
        }
        this.pending.clear();
    }
}
