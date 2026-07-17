import { cpSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bucheRun } from "../src/core.ts";
import { InertInterface } from "../src/interface.tsx";
import type { IncomingInterfaceMessage } from "../src/interface-exchange/incoming.ts";
import { ProcessCommunicator } from "../src/process.ts";
import { AsyncQueue, resetId } from "../src/utils.ts";
import { Zone } from "../src/zone.ts";

interface _Common {
    messages: Array<IncomingInterfaceMessage>;
    process: ProcessCommunicator;
}

export interface SimulateArgs extends _Common {
    /** Seconds of silence (no message of any kind) required before the next
     *  interface message is emitted. */
    pause: number;
}

export interface ReplayArgs extends _Common {
    /** A previous output of `simulate` (the tagged message sequence). The run is
     *  checked against it, and interface messages are injected as soon as they
     *  become the next expected message rather than waiting for silence. */
    replay: Array<any>;

    /** Seconds of initial silence to wait for before injecting the *first*
     *  interface message, letting the driver finish booting so its startup burst
     *  is observed in the recorded order. Subsequent messages are still injected
     *  as-soon-as-expected. Default: 0 (no settle). */
    pause?: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const sameMessage = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Run `bucheRun()` and yield every message that flows through it, tagged with
 * its origin (`driverIn`, `driverOut`, `interfaceIn`, `interfaceOut`).
 *
 * Two modes:
 *
 *   - **Simulate** ({@link SimulateArgs}): interface messages are staggered —
 *     each one is only emitted once `pause` seconds have elapsed without any
 *     message (of any kind) being seen, letting the system settle between
 *     simulated user actions.
 *
 *   - **Replay** ({@link ReplayArgs}): the run is compared against a previous
 *     output. Interface messages are emitted immediately, as soon as each one
 *     is the next expected message in the recorded sequence (no waiting). If the
 *     observed sequence diverges from `replay`, the generator throws.
 */
export async function* simulate(args: SimulateArgs | ReplayArgs): AsyncGenerator<any> {
    const queue = new AsyncQueue<any>();
    const replay = "replay" in args ? args.replay : null;

    // --- Replay bookkeeping -------------------------------------------------
    // Cursor into the expected sequence, plus a change notifier so the interface
    // stream can wake up when the cursor advances (or the driver side finishes).
    let cursor = 0;
    let driverDone = false;
    let replayError: Error | null = null;
    let waiters: Array<() => void> = [];
    const signal = () => {
        const pending = waiters;
        waiters = [];
        for (const resolve of pending) {
            resolve();
        }
    };
    const waitForChange = () => new Promise<void>((resolve) => waiters.push(resolve));

    // --- Simulate bookkeeping ----------------------------------------------
    // Timestamp of the most recent message of any kind, used to detect silence.
    let lastActivity = Date.now();

    const tagAndPush = (role: string) => (x: any) => {
        // Messages may be mutable objects that the core mutates after they flow
        // through here. Snapshot immediately (serialize as early as possible) so
        // both the replay comparison and any recorded output capture the message
        // exactly as it was at this moment, not some later mutated state.
        const snapshot = JSON.parse(
            JSON.stringify(x, (_key, value) =>
                value !== null && typeof value === "object" && "serialId" in value
                    ? `#${value.serialId}`
                    : value,
            ),
        );
        snapshot.$role = role;
        lastActivity = Date.now();
        if (globalThis.process.env.SIM_DEBUG) {
            console.error(`[tagAndPush] cursor=${cursor} role=${role} type=${snapshot.type}`);
        }
        if (replay) {
            const expected = replay[cursor];
            if (!expected || !sameMessage(expected, snapshot)) {
                replayError ??= new Error(
                    `Replay mismatch at index ${cursor}:\n` +
                        `  expected: ${JSON.stringify(expected)}\n` +
                        `  obtained: ${JSON.stringify(snapshot)}`,
                );
                args.process.kill();
            }
            cursor++;
            signal();
        }
        queue.push(snapshot);
    };

    // Interface stream, simulate mode: wait for `pause` seconds of silence.
    async function* staggerByPause(): AsyncGenerator<IncomingInterfaceMessage> {
        const pauseMs = (args as SimulateArgs).pause * 1000;
        for (const message of args.messages) {
            for (;;) {
                const quietFor = Date.now() - lastActivity;
                if (quietFor >= pauseMs) {
                    break;
                }
                await sleep(pauseMs - quietFor);
            }
            yield message;
        }
    }

    // Interface stream, replay mode: emit the next message as soon as it is the
    // next expected message (an `interfaceIn` entry at the cursor). If the driver
    // side finishes first, flush the remaining messages immediately.
    //
    // Before anything is injected, wait a fixed `pause` seconds so the driver
    // process has time to start up and emit its boot burst (observed in the
    // recorded order) before the first interface message reaches it.
    async function* staggerByReplay(): AsyncGenerator<IncomingInterfaceMessage> {
        const pauseMs = ((args as ReplayArgs).pause ?? 0) * 1000;
        if (globalThis.process.env.SIM_DEBUG) {
            console.error(
                `[staggerByReplay] ENTER pauseMs=${pauseMs} messages=${args.messages.length}`,
            );
        }
        if (pauseMs > 0) {
            await sleep(pauseMs);
        }
        if (globalThis.process.env.SIM_DEBUG) {
            console.error(`[staggerByReplay] after sleep`);
        }
        for (const message of args.messages) {
            for (;;) {
                // Register interest *before* checking, so a concurrent advance
                // can't slip through between the check and the await.
                const changed = waitForChange();
                if (replayError) {
                    return;
                }
                if (globalThis.process.env.SIM_DEBUG) {
                    console.error(
                        `[staggerByReplay] want=${message.type} cursor=${cursor} replay[cursor].$role=${replay?.[cursor]?.$role} driverDone=${driverDone}`,
                    );
                }
                if (driverDone || replay?.[cursor]?.$role === "interfaceIn") {
                    break;
                }
                await changed;
            }
            if (globalThis.process.env.SIM_DEBUG) {
                console.error(`[staggerByReplay] YIELD ${message.type} at cursor=${cursor}`);
            }
            yield message;
        }
    }

    // Wrap the process so we learn when its message stream is exhausted; this
    // lets the replay interface stream flush and avoids deadlock.
    const process = {
        messages: async function* () {
            try {
                yield* args.process.messages();
            } finally {
                driverDone = true;
                signal();
            }
        },
        send: (message: any) => args.process.send(message),
        kill: (signal?: any) => {
            if (globalThis.process.env.SIM_DEBUG) {
                console.error(`[kill] signal=${signal}\n${new Error().stack}`);
            }
            return args.process.kill(signal);
        },
    } as unknown as ProcessCommunicator;

    void (async () => {
        try {
            await bucheRun({
                process,
                interface: new InertInterface(replay ? staggerByReplay() : staggerByPause(), [
                    new Zone("@"),
                ]),
                loggers: {
                    driverIn: tagAndPush("driverIn"),
                    driverOut: tagAndPush("driverOut"),
                    interfaceIn: tagAndPush("interfaceIn"),
                    interfaceOut: tagAndPush("interfaceOut"),
                },
            });
        } finally {
            if (replay && !replayError && cursor < replay.length) {
                replayError = new Error(
                    `Replay ended early: expected ${replay.length} messages, saw ${cursor}.`,
                );
            }
            queue.end();
        }
    })();

    yield* queue;

    if (replayError) {
        throw replayError;
    }
}

// --- Command-line driver ---------------------------------------------------
// The bulk of the `scripts/sim.ts` behavior lives here so the script stays a
// thin shell. To avoid a dependency on the pretty-printer, `formatMessage` is
// injected through {@link RunSimConfig}.

function readJsonl(path: string): any[] {
    return readFileSync(path, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line));
}

export function writeJsonl(path: string, items: any[]): void {
    writeFileSync(path, items.map((item) => `${JSON.stringify(item)}\n`).join(""));
}

/** An optional leading line that supplies the command and pause. */
export interface BootLine {
    type: "boot";
    command?: string;
    pause?: number;
}

/**
 * Read a JSONL file, splitting off a leading `boot` line if present. The boot
 * line is returned separately and removed from `items`.
 */
export function readJsonlWithBoot(path: string): { boot: BootLine | null; items: any[] } {
    const items = readJsonl(path);
    if (items.length > 0 && items[0]?.type === "boot") {
        return { boot: items[0] as BootLine, items: items.slice(1) };
    }
    return { boot: null, items };
}

/** Parsed command-line options (the `values` produced by `parseArgs`). */
export interface SimCliArgs {
    command?: string;
    dir?: string;
    pause?: string;
    replay?: string;
    input?: string;
    output?: string;
    verbose?: boolean;
}

/** Extra behavior the script supplies that this module shouldn't depend on. */
export interface RunSimConfig {
    /** Called with every message that flows through the run, in order. Defaults
     *  to a no-op — the caller decides how (or whether) to render each message. */
    log?: (message: any) => void;
}

/** Milliseconds to wait for the next expected message during a replay before
 *  giving up, so a diverging replay fails instead of hanging forever. */
const REPLAY_TIMEOUT_MS = 1000;

/**
 * Wrap an async message stream so that each awaited message must arrive within
 * `timeoutMs`; otherwise throw. Used in replay mode, where the recorded sequence
 * dictates exactly what should come next — if it never does, the run would
 * otherwise hang.
 */
async function* withTimeout<T>(
    gen: AsyncGenerator<T>,
    timeoutMs: number,
    expected: any[],
): AsyncGenerator<T> {
    const iterator = gen[Symbol.asyncIterator]();
    // Each message the stream emits corresponds to one entry consumed from the
    // recorded sequence, so `seen` doubles as the cursor into `expected`.
    let seen = 0;
    for (;;) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
                const next = expected[seen];
                reject(
                    new Error(
                        `Replay timed out: waited more than ${timeoutMs}ms for the next expected message:\n` +
                            `  ${next === undefined ? "(none — replay already complete)" : JSON.stringify(next)}`,
                    ),
                );
            }, timeoutMs);
        });
        try {
            const result = await Promise.race([iterator.next(), timeout]);
            if (result.done) {
                return;
            }
            seen++;
            yield result.value;
        } finally {
            clearTimeout(timer);
        }
    }
}

/** Run a simulation (or replay) described entirely by parsed CLI options. */
export async function runSim(values: SimCliArgs, config: RunSimConfig = {}): Promise<void> {
    const log = config.log ?? (() => {});

    const input = values.input ? readJsonlWithBoot(values.input) : { boot: null, items: [] };
    const replayFile = values.replay ? readJsonlWithBoot(values.replay) : null;

    // The boot line supplies defaults; explicit flags take precedence. A boot line
    // on the input file wins over one on the replay file.
    const boot = input.boot ?? replayFile?.boot ?? null;

    const command = values.command ?? boot?.command;
    if (!command) {
        console.error("error: no command given (use -c/--command or a boot line)");
        globalThis.process.exit(1);
    }

    const pause =
        values.pause !== undefined ? Number.parseFloat(values.pause) : (boot?.pause ?? 0.5);

    // When --dir is given, it must be a directory. Copy it to a fresh temp location
    // and run the command there, so the original is left untouched.
    let cwd: string | undefined;
    if (values.dir !== undefined) {
        let stat: ReturnType<typeof statSync>;
        try {
            stat = statSync(values.dir);
        } catch (_e) {
            console.error(`error: --dir path does not exist: ${values.dir}`);
            globalThis.process.exit(1);
        }
        if (!stat.isDirectory()) {
            console.error(`error: --dir must point to a directory: ${values.dir}`);
            globalThis.process.exit(1);
        }
        cwd = mkdtempSync(join(tmpdir(), "buche-sim-"));
        cpSync(values.dir, cwd, { recursive: true });
    }

    const messages = input.items as Array<IncomingInterfaceMessage>;

    const common = {
        process: new ProcessCommunicator(command, { cwd }),
        messages,
    };

    const args: SimulateArgs | ReplayArgs = replayFile
        ? { ...common, replay: replayFile.items, pause }
        : { ...common, pause };

    // Deterministic ids, so a replay lines up with its recording.
    resetId(0);

    const collected: any[] = [];
    // In replay mode, guard against a diverging run hanging by requiring each
    // expected message to arrive within REPLAY_TIMEOUT_MS.
    const stream = replayFile
        ? withTimeout(simulate(args), REPLAY_TIMEOUT_MS, replayFile.items)
        : simulate(args);
    try {
        for await (const message of stream) {
            collected.push(message);
            log(message);
        }
        // } catch (err: any) {
        //     console.error(`\n${err.message}`);
        //     globalThis.process.exitCode = 1;
        //     // A timed-out replay leaves the driver process running; stop it.
        //     common.process.kill();
    } finally {
        if (values.output) {
            const bootLine: BootLine = { type: "boot", command, pause };
            writeJsonl(values.output, [bootLine, ...collected]);
            console.error(`\nWrote ${collected.length} messages to ${values.output}`);
        }
    }
}
