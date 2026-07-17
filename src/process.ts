import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import * as readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { DataMessage } from "./driver-exchange/_data.ts";
import type { TextMessage } from "./driver-exchange/_text.ts";
import type { Address, Json, To } from "./driver-exchange/common.ts";
import type { IncomingDriverMessage } from "./driver-exchange/incoming.ts";
import type { OutgoingDriverMessage } from "./driver-exchange/outgoing.ts";
import { driverParser } from "./parse.ts";
import type { ErrorMessage } from "./utils.ts";

/** A message produced by the process: either a valid driver message or a parse error. */
export type ProcessMessage = IncomingDriverMessage | ErrorMessage;

/**
 * What to do with a readable output descriptor (fd1, fd2 or fd4):
 *   - `"include"`  — read it and emit messages into {@link ProcessCommunicator.run}
 *   - `"suppress"` — discard the output entirely (routed to /dev/null)
 *   - `"ignore"`   — pass it through to this process's own matching stream (inherit)
 */
export type StreamMode = "include" | "suppress" | "ignore";

export interface ProcessCommunicatorOptions {
    /** Address stamped on synthesized messages (fd1/fd2/fd4 and the close message). */
    from?: Address;
    /** Target stamped on synthesized messages. Defaults to the terminal. */
    to?: To;
    /** Working directory for the process. */
    cwd?: string;
    /** Extra environment variables (merged on top of the parent environment). */
    env?: Record<string, string>;
    /** How to handle fd1 (stdout). Defaults to `"include"`. */
    stdout?: StreamMode;
    /** How to handle fd2 (stderr). Defaults to `"include"`. */
    stderr?: StreamMode;
    /** How to handle fd4 (dataout). Defaults to `"include"`. */
    data?: StreamMode;
}

/**
 * Map a {@link StreamMode} to the corresponding Node `stdio` entry.
 *
 * `"suppress"` uses a real pipe (drained and discarded by the reader) rather
 * than Node's `"ignore"`: the latter leaves higher fds (e.g. fd4) unopened in
 * the child, so writing to them would fail with `EBADF`. A drained pipe keeps
 * the descriptor valid while throwing its output away.
 */
function stdioEntry(mode: StreamMode): "pipe" | "inherit" {
    return mode === "ignore" ? "inherit" : "pipe";
}

/**
 * A minimal unbounded async queue with a single consumer. Producers `push`
 * values and call `end` when no more values will arrive; the consumer drains it
 * with `for await`.
 */
class AsyncQueue<T> {
    private items: T[] = [];
    private waiting: ((result: IteratorResult<T>) => void)[] = [];
    private ended = false;

    push(item: T): void {
        if (this.ended) {
            return;
        }
        const resolve = this.waiting.shift();
        if (resolve) {
            resolve({ value: item, done: false });
        } else {
            this.items.push(item);
        }
    }

    end(): void {
        if (this.ended) {
            return;
        }
        this.ended = true;
        for (const resolve of this.waiting) {
            resolve({ value: undefined as never, done: true });
        }
        this.waiting = [];
    }

    async *[Symbol.asyncIterator](): AsyncGenerator<T> {
        while (true) {
            if (this.items.length > 0) {
                yield this.items.shift() as T;
            } else if (this.ended) {
                return;
            } else {
                const result = await new Promise<IteratorResult<T>>((resolve) => {
                    this.waiting.push(resolve);
                });
                if (result.done) {
                    return;
                }
                yield result.value;
            }
        }
    }
}

/**
 * Spawns a child process wired up with the Buche file-descriptor protocol and
 * turns everything it emits into a single stream of driver messages.
 *
 * File descriptors (from the child's point of view):
 *   - fd0 (stdin)   — opened, otherwise untouched
 *   - fd1 (stdout)  — configurable ({@link StreamMode}); when included, every chunk
 *                     becomes a {@link TextMessage} (stdout)
 *   - fd2 (stderr)  — configurable ({@link StreamMode}); when included, every chunk
 *                     becomes a {@link TextMessage} (stderr)
 *   - fd3 (datain)  — opened, otherwise untouched
 *   - fd4 (dataout) — configurable ({@link StreamMode}); when included, read as a JSONL
 *                     stream and each line becomes a {@link DataMessage}
 *   - fd5 (control) — bidirectional; read as a stream of {@link IncomingDriverMessage},
 *                     and written to by {@link ProcessCommunicator.send}
 */
export class ProcessCommunicator {
    private readonly command: string | string[];
    private readonly from: Address;
    private readonly to: To;
    private readonly options: ProcessCommunicatorOptions;

    private child: ChildProcess | null = null;
    private control: Writable | null = null;
    private readonly queue = new AsyncQueue<ProcessMessage>();

    /** Number of pending completion signals before the queue can be closed. */
    private pending = 0;
    private exitCode: number | null = null;
    private exitSignal: NodeJS.Signals | null = null;

    /**
     * @param command  A list of `[program, ...args]` to execute directly, or a
     *                 single string to execute through the shell.
     */
    constructor(command: string | string[], options: ProcessCommunicatorOptions = {}) {
        this.command = command;
        this.options = options;
        this.from = options.from ?? [];
        this.to = options.to ?? ["$terminal"];
        this.start();
    }

    /** Async-iterate every message emitted by the process until it exits. */
    async *messages(): AsyncGenerator<ProcessMessage> {
        yield* this.queue;
    }

    /** Serialize an outgoing message as JSON and write it to fd5 on a single line. */
    send(message: OutgoingDriverMessage): void {
        if (!this.control || !this.control.writable) {
            throw new Error("control channel (fd5) is not available");
        }
        this.control.write(`${JSON.stringify(message)}\n`);
    }

    /** Terminate the underlying process. */
    kill(signal?: NodeJS.Signals | number): boolean {
        return this.child?.kill(signal) ?? false;
    }

    private start(): void {
        const spawnOptions: SpawnOptions = {
            stdio: [
                "pipe", // fd0 stdin  — opened, untouched
                stdioEntry(this.options.stdout ?? "include"), // fd1 stdout
                stdioEntry(this.options.stderr ?? "include"), // fd2 stderr
                "pipe", // fd3 datain — opened, untouched
                stdioEntry(this.options.data ?? "include"), // fd4 dataout
                "pipe", // fd5 control
            ],
            cwd: this.options.cwd,
            env: {
                ...process.env,
                BUCHE_CONTROL_FD: "5",
                BUCHE_DATA_FD: "4",
                ...this.options.env,
            },
        };

        const child = Array.isArray(this.command)
            ? spawn(this.command[0], this.command.slice(1), spawnOptions)
            : spawn(this.command, { ...spawnOptions, shell: true });
        this.child = child;

        // `child.stdio` is typed as a 5-tuple, but we opened fd5 (a duplex) too.
        const fds = child.stdio as unknown as ((Readable & Writable) | null)[];
        this.control = fds[5] ?? null;

        // fd1 (stdout) and fd2 (stderr): when included, every chunk becomes a TextMessage.
        this.pipeText(fds[1], "stdout", this.options.stdout ?? "include");
        this.pipeText(fds[2], "stderr", this.options.stderr ?? "include");

        // fd4 (dataout): when included, a JSONL stream of DataMessages.
        this.pipeData(fds[4], this.options.data ?? "include");

        // fd5 (control): stream of IncomingDriverMessages.
        this.pipeControl(fds[5]);

        // Process lifecycle.
        this.pending += 1;
        child.on("close", (code, signal) => {
            this.exitCode = code;
            this.exitSignal = signal;
            this.done();
        });
        child.on("error", (err) => {
            this.queue.push({
                type: "error",
                code: "process",
                subcode: "spawn",
                reason: err.message,
                input: this.command,
            });
            // A failed spawn may never emit "close"; make sure we terminate.
            this.queue.end();
        });

        // fd0 (stdin) and fd3 (datain): opened for the child, nothing to do here.
    }

    private pipeText(stream: Readable | null, name: "stdout" | "stderr", mode: StreamMode): void {
        // `null` means the fd was inherited ("ignore"): nothing to read here.
        if (!stream) {
            return;
        }
        this.pending += 1;
        if (mode === "suppress") {
            stream.resume(); // drain and discard
        } else {
            stream.setEncoding("utf8");
            stream.on("data", (text: string) => {
                const message: TextMessage = {
                    type: "text",
                    from: this.from,
                    to: this.to,
                    stream: name,
                    text,
                };
                this.queue.push(message);
            });
        }
        stream.on("error", () => {});
        stream.on("end", () => this.done());
    }

    private pipeData(stream: Readable | null, mode: StreamMode): void {
        // `null` means the fd was inherited ("ignore"): nothing to read here.
        if (!stream) {
            return;
        }
        this.pending += 1;
        if (mode === "suppress") {
            stream.resume(); // drain and discard
            stream.on("error", () => {});
            stream.on("end", () => this.done());
            return;
        }
        const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
        lines.on("error", () => {});
        lines.on("line", (line: string) => {
            const trimmed = line.trim();
            if (!trimmed) {
                return;
            }
            let data: Json;
            try {
                data = JSON.parse(trimmed);
            } catch (_e) {
                this.queue.push({
                    type: "error",
                    code: "invalid_message",
                    subcode: "notjson",
                    reason: "fd4 data must be parsable as JSON",
                    input: line,
                });
                return;
            }
            const message: DataMessage = {
                type: "data",
                from: this.from,
                to: this.to,
                data,
            };
            this.queue.push(message);
        });
        lines.on("close", () => this.done());
    }

    private pipeControl(stream: Readable | null): void {
        if (!stream) {
            return;
        }
        this.pending += 1;
        void (async () => {
            try {
                for await (const message of driverParser.stream(stream)) {
                    this.queue.push(message);
                }
            } catch (err: any) {
                this.queue.push({
                    type: "error",
                    code: "process",
                    subcode: "control",
                    reason: err?.message ?? String(err),
                    input: null,
                });
            } finally {
                this.done();
            }
        })();
    }

    /** Signal that one source has finished; close the queue once all have. */
    private done(): void {
        this.pending -= 1;
        if (this.pending > 0) {
            return;
        }
        this.queue.push({
            type: "close",
            from: this.from,
            to: this.to,
            outcome: {
                type: this.exitCode === 0 && this.exitSignal === null ? "success" : "error",
                ...(this.exitCode !== null && { code: this.exitCode }),
            },
        });
        this.queue.end();
    }
}
