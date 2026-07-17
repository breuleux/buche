/**
 * Run a Buche simulation from the command line.
 *
 * Usage:
 *   node scripts/sim.ts -c COMMAND [-p PAUSE] [-i MESSAGES_FILE] [-o REPLAY_FILE]
 *   node scripts/sim.ts -c COMMAND --replay FILE [-i MESSAGES_FILE]
 *
 * Options:
 *   -c, --command COMMAND   Shell command to run as the driver process (required).
 *   -p, --pause  PAUSE      Seconds of silence before each interface message is
 *                           injected (simulate mode). Default: 0.5.
 *       --replay FILE       Replay a previous run (a REPLAY_FILE). Interface
 *                           messages are injected as soon as they are expected,
 *                           and the run is checked against the recorded
 *                           sequence — any divergence is a fatal error.
 *   -i, --input  FILE       JSONL file of interface messages to inject. Default: none.
 *   -o, --output FILE       Write the tagged message sequence here (JSONL), so it
 *                           can later be passed to --replay.
 *   -v, --verbose           When pretty-printing to a tty, show full field values
 *                           instead of truncating them, expanding any JSON (including
 *                           JSON held in strings) with proper indentation.
 *
 * Both the input and replay/output files are JSONL: one JSON object per line.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { IncomingInterfaceMessage } from "../src/interface-exchange/incoming.ts";
import { ProcessCommunicator } from "../src/process.ts";
import { resetId } from "../src/utils.ts";
import { type ReplayArgs, type SimulateArgs, simulate } from "../tests/sim.ts";
import { formatMessage } from "./format.ts";

function readJsonl(path: string): any[] {
    return readFileSync(path, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line));
}

function writeJsonl(path: string, items: any[]): void {
    writeFileSync(path, items.map((item) => `${JSON.stringify(item)}\n`).join(""));
}

const { values } = parseArgs({
    options: {
        command: { type: "string", short: "c" },
        pause: { type: "string", short: "p" },
        replay: { type: "string" },
        input: { type: "string", short: "i" },
        output: { type: "string", short: "o" },
        verbose: { type: "boolean", short: "v" },
    },
});

if (!values.command) {
    console.error("error: -c/--command is required");
    process.exit(1);
}

const messages: Array<IncomingInterfaceMessage> = values.input ? readJsonl(values.input) : [];

const common = {
    process: new ProcessCommunicator(values.command),
    messages,
};

const args: SimulateArgs | ReplayArgs = values.replay
    ? { ...common, replay: readJsonl(values.replay) }
    : { ...common, pause: values.pause ? Number.parseFloat(values.pause) : 0.5 };

// Deterministic ids, so a replay lines up with its recording.
resetId(0);

// On a tty, pretty-print for humans; otherwise emit JSONL identical to -o.
const pretty = Boolean(process.stdout.isTTY);
const width = process.stdout.columns || 80;

const collected: any[] = [];
try {
    for await (const message of simulate(args)) {
        collected.push(message);
        if (pretty) {
            console.log(formatMessage(message, { verbose: values.verbose, width, color: true }));
        } else {
            console.log(JSON.stringify(message));
        }
    }
} catch (err: any) {
    console.error(`\n${err.message}`);
    process.exitCode = 1;
} finally {
    if (values.output) {
        writeJsonl(values.output, collected);
        console.error(`\nWrote ${collected.length} messages to ${values.output}`);
    }
}
