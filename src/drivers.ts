// The driver processes of a terminal (a window, a view session): the one it
// starts with, and the shells started later at the interface's request (a
// `spawn` message: see SpawnRequest), each at an address of its own.
//
// The first driver's addresses are its own. Another one's live under its
// address (`["$d1"]`...): what it sends comes back with `from` (and
// `represents`) under it, and messages to addresses under it go to it, with
// the prefix taken off. A `signal` to a driver's `["$proc"]` kills it.

import type { InM } from "./core.ts";
import type {
    OutgoingDriverMessage,
    SignalRequest,
    SpawnRequest,
} from "./driver-exchange/outgoing.ts";
import { ProcessCommunicator, type ProcessCommunicatorOptions } from "./process.ts";
import type { Address } from "./types.ts";

export interface DriversOptions {
    /** Where the drivers run. */
    cwd?: string;
    /** Each message from a driver, addresses rewritten. */
    receive(message: InM): void;
    /** Every driver has exited. */
    exited?(): void;
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
        void (async () => {
            try {
                for await (const message of proc.messages()) {
                    const m = message as unknown as Record<string, unknown>;
                    this.options.receive({
                        ...m,
                        from: under(m.from),
                        ...("represents" in m ? { represents: under(m.represents) } : {}),
                    } as unknown as InM);
                }
            } catch (err) {
                console.error(`[buche] driver ${id || "(first)"}: stream error:`, err);
            }
        })();
        void proc.exited.then(() => {
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
