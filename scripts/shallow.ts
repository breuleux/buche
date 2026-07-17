/**
 * Run a Buche simulation from the command line.
 *
 * Usage:
 *   node scripts/shallow.ts -c COMMAND [-p PAUSE] [-i MESSAGES_FILE] [-o REPLAY_FILE]
 *   node scripts/shallow.ts -c COMMAND --replay FILE [-i MESSAGES_FILE]
 *
 * Options:
 *   -c, --command COMMAND   Shell command to run as the driver process (required).
 *   -d, --dir    DIR        A directory to copy; the copy becomes the command's
 *                           current working directory. Must point to a directory.
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
 *
 * As a convenience, the first line of the input file (or of a replay file) may
 * be a "boot" line — `{"type": "boot", "command": "...", "pause": 0.1}` — which
 * supplies the command and pause. Explicit -c/--command and -p/--pause flags
 * take precedence over it. When an output file is written, a matching boot line
 * is emitted as its first line, so the file can be replayed without extra flags.
 *
 * The bulk of the behavior lives in `tests/sim.ts` (`runSim`); this file only
 * parses arguments and supplies the logger.
 */

// Must come first: installs DOM globals (HTMLElement, customElements, …) before
// any module that defines custom-element classes at load time is imported.
import "./dom-setup.ts";
import { parseArgs } from "node:util";
import { runSim } from "../tests/sim.ts";
import { formatMessage } from "./format.ts";

const { values } = parseArgs({
    options: {
        command: { type: "string", short: "c" },
        dir: { type: "string", short: "d" },
        pause: { type: "string", short: "p" },
        replay: { type: "string" },
        input: { type: "string", short: "i" },
        output: { type: "string", short: "o" },
        verbose: { type: "boolean", short: "v" },
    },
});

// On a tty, pretty-print for humans; otherwise emit JSONL identical to -o.
const pretty = Boolean(process.stdout.isTTY);
const width = process.stdout.columns || 80;
const log = pretty
    ? (message: any) =>
          console.log(formatMessage(message, { verbose: values.verbose, width, color: true }))
    : (message: any) => console.log(JSON.stringify(message));

await runSim(values, { log });
