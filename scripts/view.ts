/**
 * Serve a live Buche view in the browser.
 *
 * Starts a local web server and opens it. The Buche core and interface run
 * client-side (see scripts/view-client.ts): the server only spawns the driver
 * process and bridges it to the page over a WebSocket.
 *
 *   process (server)  ⇄  WebSocket  ⇄  Buche + BucheInterface (browser)
 *
 *   - The process's output (driver-incoming messages) is relayed to the browser,
 *     where it is fed into `buche.handle`.
 *   - The core's `sendDriver` output (driver-outgoing messages) comes back over
 *     the socket and is written to the process (a `signal` addressed to `$proc`
 *     kills it instead).
 *
 * Usage:
 *   bun run scripts/view.ts -c COMMAND [-l LAYOUT] [--port PORT] [-d DIR]
 *   bun run scripts/view.ts -i INPUT.jsonl        # command comes from a boot line
 *
 * Options (the command/dir/… set mirrors scripts/shallow.ts):
 *   -c, --command COMMAND   Shell command to run as the driver process.
 *   -i, --input   FILE      JSONL of interface messages to replay into each
 *                           session. Each is injected over the socket once the
 *                           session has been quiet (no message either way) for
 *                           --pause seconds, so an action waits for the previous
 *                           one to settle. A leading `boot` line — {"type":"boot",
 *                           "command":"…","pause":0.1} — supplies the command and
 *                           pause, so `-i FILE` can stand in for `-c`.
 *       --replay  FILE      JSONL whose leading `boot` line may supply the command
 *                           and pause (its recorded body is not replayed here,
 *                           since the interface runs in the browser).
 *   -p, --pause   PAUSE     Seconds of quiet required before each injected
 *                           interface message. Default: 0.5 (or boot line pause).
 *   -d, --dir     DIR       A directory to copy; the copy becomes the command's
 *                           working directory. Must point to a directory.
 *   -l, --layout  FILE      HTML layout whose zones seed the interface.
 *                           Default: layouts/standard.html.
 *       --port    PORT      Port to listen on. Default: 0 (pick a free port).
 *   -o, --output  FILE      Accepted for CLI compatibility (unused here).
 *   -v, --verbose           Expand full field values when pretty-printing the
 *                           driver message stream (which is always logged).
 *
 * Command precedence: -c/--command, then the input file's boot line, then the
 * replay file's boot line. The driver messages the server relays in each
 * direction are printed to the console; the interface-side stream is logged in
 * the browser's devtools.
 */

import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import type { ServerWebSocket } from "bun";
import type { OutgoingDriverMessage, SignalRequest } from "../src/driver-exchange/outgoing.ts";
import { ProcessCommunicator } from "../src/process.ts";
import { formatMessage } from "./format.ts";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** An optional leading line of an input/replay file supplying the command/pause. */
interface BootLine {
    type: "boot";
    command?: string;
    pause?: number;
}

/** Read a JSONL file into an array of parsed objects (blank lines skipped). */
function readJsonl(path: string): unknown[] {
    return readFileSync(path, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line));
}

/** Read a JSONL file, splitting off a leading `boot` line if present. */
function readJsonlWithBoot(path: string): { boot: BootLine | null; items: unknown[] } {
    const items = readJsonl(path);
    if (items.length > 0 && (items[0] as { type?: string })?.type === "boot") {
        return { boot: items[0] as BootLine, items: items.slice(1) };
    }
    return { boot: null, items };
}

const { values } = parseArgs({
    options: {
        command: { type: "string", short: "c" },
        dir: { type: "string", short: "d" },
        layout: { type: "string", short: "l" },
        port: { type: "string" },
        pause: { type: "string", short: "p" },
        replay: { type: "string" },
        input: { type: "string", short: "i" },
        output: { type: "string", short: "o" },
        verbose: { type: "boolean", short: "v" },
    },
});

// Read the interface-message file (-i) and/or replay file (--replay). A leading
// `boot` line in either supplies the command and pause, so `-i FILE` can stand
// in for `-c`. Explicit flags win; an input boot line beats a replay one.
const input = values.input ? readJsonlWithBoot(values.input) : { boot: null, items: [] };
const replayFile = values.replay ? readJsonlWithBoot(values.replay) : null;
const boot = input.boot ?? replayFile?.boot ?? null;

const command = values.command ?? boot?.command;
if (!command) {
    console.error("error: no command given (use -c/--command, or -i/--replay with a boot line)");
    process.exit(1);
}

const pause = values.pause !== undefined ? Number.parseFloat(values.pause) : (boot?.pause ?? 0.5);

// Interface messages replayed into each session (from the -i file). They are
// sent over the socket so the browser-side Buche handles them as user actions.
const injectedMessages = input.items;

// When --dir is given, it must be a directory. Copy it to a fresh temp location
// so the command runs against a throwaway copy and the original is untouched.
let cwd: string | undefined;
if (values.dir !== undefined) {
    let stat: ReturnType<typeof statSync>;
    try {
        stat = statSync(values.dir);
    } catch (_e) {
        console.error(`error: --dir path does not exist: ${values.dir}`);
        process.exit(1);
    }
    if (!stat.isDirectory()) {
        console.error(`error: --dir must point to a directory: ${values.dir}`);
        process.exit(1);
    }
    cwd = mkdtempSync(join(tmpdir(), "buche-view-"));
    cpSync(values.dir, cwd, { recursive: true });
}

const scriptDir = dirname(new URL(import.meta.url).pathname);
const componentsDir = join(scriptDir, "../src/components");
const layoutPath = values.layout ?? join(scriptDir, "../layouts/standard.html");
const layout = readFileSync(layoutPath, "utf8");

// Bundle the component definitions for the browser (self-registering custom
// elements) so the layout renders. Built once at startup, in memory.
const build = await Bun.build({
    entrypoints: [join(scriptDir, "view-client.ts")],
    target: "browser",
    minify: true,
});
if (!build.success) {
    for (const log of build.logs) {
        console.error(String(log));
    }
    process.exit(1);
}
const clientJs = await build.outputs[0].text();

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Buche</title>
<link rel="stylesheet" href="/components.css" />
<style>
  :root { color-scheme: dark; }
  html, body { margin: 0; height: 100%; }
  body {
    /* Very dark grey. */
    background: #141414;
    color: #d0d0d0;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  #buche { position: fixed; inset: 0; }
  #buche > * { width: 100%; height: 100%; }
</style>
</head>
<body>
<div id="buche">${layout}</div>
<script type="module" src="/client.js"></script>
</body>
</html>
`;

/** Per-connection state: the driver process plus a timestamp of the last
 *  message seen in *either* direction, used to pace injected messages. */
interface Session {
    proc: ProcessCommunicator;
    lastActivity: number;
}

// One session per open socket, torn down when the socket closes.
const sessions = new WeakMap<ServerWebSocket<unknown>, Session>();

// On a tty, pretty-print the message stream for humans; otherwise emit JSONL.
const pretty = Boolean(process.stdout.isTTY);
const width = process.stdout.columns || 80;

/** Print one driver message to the console, tagged with its direction. */
function logMessage(role: string, message: unknown): void {
    const tagged = { ...(message as object), $role: role };
    console.log(
        pretty
            ? formatMessage(tagged, { verbose: values.verbose, width, color: true })
            : JSON.stringify(tagged),
    );
}

/** Spawn the driver process for a connection and relay its output to the page. */
function startSession(ws: ServerWebSocket<unknown>): void {
    const proc = new ProcessCommunicator(command as string, { cwd });
    const session: Session = { proc, lastActivity: Date.now() };
    sessions.set(ws, session);

    void (async () => {
        try {
            for await (const message of proc.messages()) {
                session.lastActivity = Date.now();
                logMessage("driverIn", message);
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify(message));
                }
            }
        } catch (err) {
            console.error("[buche] process stream error:", err);
        }
    })();

    injectMessages(ws, session);
}

/** Replay the -i interface messages into a session by sending each over the
 *  socket for the browser-side Buche to handle as a user action (which drives
 *  the process back through the client). Each is held until the session has been
 *  quiet — no message in either direction — for `pause` seconds, so a following
 *  action (e.g. a kill signal) waits for the previous one's round-trip to settle
 *  rather than firing on a fixed timer. */
function injectMessages(ws: ServerWebSocket<unknown>, session: Session): void {
    if (injectedMessages.length === 0) {
        return;
    }
    const pauseMs = pause * 1000;
    void (async () => {
        for (const message of injectedMessages) {
            // Wait until it has been quiet for `pause` seconds.
            for (;;) {
                if (ws.readyState !== WebSocket.OPEN) {
                    return;
                }
                const quietFor = Date.now() - session.lastActivity;
                if (quietFor >= pauseMs) {
                    break;
                }
                await sleep(pauseMs - quietFor);
            }
            logMessage("interfaceIn", message);
            session.lastActivity = Date.now();
            ws.send(JSON.stringify(message));
        }
    })();
}

/** Handle a driver-outgoing message the client sent back: write it to the
 *  process, or — for a signal addressed to `$proc` — kill the process. */
function handleClientMessage(ws: ServerWebSocket<unknown>, raw: string): void {
    let message: OutgoingDriverMessage;
    try {
        message = JSON.parse(raw);
    } catch (err) {
        console.error("[buche] ignoring unparseable client message:", err);
        return;
    }
    const session = sessions.get(ws);
    if (!session) {
        return;
    }
    session.lastActivity = Date.now();
    logMessage("driverOut", message);
    const signal = message as SignalRequest;
    if (message.type === "signal" && signal.to?.length === 1 && signal.to[0] === "$proc") {
        session.proc.kill(signal.code);
    } else {
        session.proc.send(message);
    }
}

function endSession(ws: ServerWebSocket<unknown>): void {
    const session = sessions.get(ws);
    sessions.delete(ws);
    session?.proc.kill();
}

const CONTENT_TYPES: Record<string, string> = {
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
};
const contentType = (ext: string): string => CONTENT_TYPES[ext] ?? "application/octet-stream";

const server = Bun.serve({
    port: values.port ? Number(values.port) : 0,
    fetch(req, server) {
        const url = new URL(req.url);
        const path = url.pathname;

        if (path === "/ws") {
            return server.upgrade(req)
                ? undefined
                : new Response("expected a websocket", { status: 426 });
        }
        if (path === "/") {
            return new Response(page, { headers: { "content-type": contentType(".html") } });
        }
        if (path === "/client.js") {
            return new Response(clientJs, { headers: { "content-type": contentType(".js") } });
        }
        // Component stylesheets: components.css and the files it @imports live in
        // src/components; serve any *.css by basename from there.
        if (path.endsWith(".css")) {
            const name = path.slice(1);
            if (!name.includes("/")) {
                const file = Bun.file(join(componentsDir, name));
                return new Response(file, { headers: { "content-type": contentType(".css") } });
            }
        }
        return new Response("not found", { status: 404 });
    },
    websocket: {
        open(ws) {
            startSession(ws);
        },
        close(ws) {
            endSession(ws);
        },
        message(ws, raw) {
            handleClientMessage(ws, typeof raw === "string" ? raw : raw.toString());
        },
    },
});

const nativeUrl = `http://localhost:${server.port}/`;
console.log(`Buche view running at ${nativeUrl}  (command: ${command})`);
openBrowser(nativeUrl);

/** Open `url` in the default browser, best-effort across platforms. */
function openBrowser(url: string): void {
    const opener =
        process.platform === "darwin"
            ? ["open", url]
            : process.platform === "win32"
              ? ["cmd", "/c", "start", "", url]
              : ["xdg-open", url];
    try {
        spawn(opener[0], opener.slice(1), { stdio: "ignore", detached: true }).unref();
    } catch (err) {
        console.error(`Could not open a browser automatically (${err}); visit ${url}`);
    }
}
