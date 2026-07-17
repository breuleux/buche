import { bucheRun } from "../src/core.ts";
import type { IncomingInterfaceMessage } from "../src/interface-exchange/incoming.ts";
import { AsyncQueue, type ProcessCommunicator } from "../src/process.ts";

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
        x.$role = role;
        lastActivity = Date.now();
        if (replay) {
            const expected = replay[cursor];
            if (!expected || !sameMessage(expected, x)) {
                replayError ??= new Error(
                    `Replay mismatch at index ${cursor}:\n` +
                        `  expected: ${JSON.stringify(expected)}\n` +
                        `  obtained: ${JSON.stringify(x)}`,
                );
                args.process.kill();
            }
            cursor++;
            signal();
        }
        queue.push(x);
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
    async function* staggerByReplay(): AsyncGenerator<IncomingInterfaceMessage> {
        for (const message of args.messages) {
            for (;;) {
                // Register interest *before* checking, so a concurrent advance
                // can't slip through between the check and the await.
                const changed = waitForChange();
                if (replayError) {
                    return;
                }
                if (driverDone || replay?.[cursor]?.$role === "interfaceIn") {
                    break;
                }
                await changed;
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
        kill: (signal?: any) => args.process.kill(signal),
    } as unknown as ProcessCommunicator;

    const run = bucheRun({
        process,
        interface: replay ? staggerByReplay() : staggerByPause(),
        loggers: {
            driverIn: tagAndPush("driverIn"),
            driverOut: tagAndPush("driverOut"),
            interfaceIn: tagAndPush("interfaceIn"),
            interfaceOut: tagAndPush("interfaceOut"),
        },
    });

    // Drive bucheRun to completion in the background. Its outputs are already
    // captured through the loggers, so we only need to pull it along and close
    // the queue when the run finishes.
    void (async () => {
        try {
            for await (const _ of run) {
                // Already pushed via loggers.
            }
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
