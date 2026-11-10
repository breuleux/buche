// Electron main process: the Electron counterpart of the WebSocket server in
// scripts/view.ts. It owns the driver process (typically the coquille shell)
// and relays its messages to the renderer, where the Buche core and the
// interface run (see electron/renderer.ts). It also registers the native
// `proc://` and `lib://` schemes for GUI cells (see electron/proc-protocol.ts).
//
// Two ways in:
// - `bun run electron` (scripts/electron.ts) builds the bundles into
//   dist/electron and starts Electron with this file, passing the run
//   configuration in the BUCHE_ELECTRON environment variable as JSON:
//   { command, cwd, layout, devtools, printMessages, update, parent, dir }.
// - The packaged app (`bun run package`, see electron-builder.yml), started
//   from the Dock, a desktop launcher or a terminal: no BUCHE_ELECTRON, the
//   same options are taken from the command line (see `argvConfig`).
// Either way the configuration (~/.config/buche/config.yaml over the
// defaults) and the layout are read here at startup, and handed to the page
// through the preload (`page:setup`). So is the shell (its `shell` section:
// see src/config.ts), its tools installed first if it has some (see
// scripts/tools.ts), and put first on PATH.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
    app,
    BrowserWindow,
    dialog,
    ipcMain,
    Menu,
    nativeImage,
    type OnBeforeRequestListenerDetails,
    systemPreferences,
} from "electron";
import { formatMessage } from "../scripts/format.ts";
import {
    expandHome,
    prependPath,
    type ResolvedShell,
    resolveShellCommand,
} from "../scripts/tools.ts";
import { loadUserConfig, resetBindings } from "../scripts/user-config.ts";
import { resolveShell } from "../src/config.ts";
import type { OutgoingDriverMessage } from "../src/driver-exchange/outgoing.ts";
import { Drivers } from "../src/drivers.ts";
import { LibraryRegistry } from "../src/library.ts";
import {
    initLibProtocol,
    initProcProtocol,
    registerProcScheme,
    setRuntimeHtml,
    setWebContents,
} from "./proc-protocol.ts";

interface RunConfig {
    /** Shell command driving the session (default: the configuration's). */
    command?: string;
    /** Look for a newer release of the shell's tools (see scripts/tools.ts). */
    update?: boolean;
    /** Pid of the launcher (scripts/electron.ts); the app quits when it dies. */
    parent?: number;
    /** The directory the build script wrote the bundles and pages into. */
    dir?: string;
    /** Working directory for the process. */
    cwd?: string;
    /** Initial layout file (carreau JSON, see layouts/). */
    layout?: string;
    /** Open the devtools on start. */
    devtools?: boolean;
    /** Print the driver messages on the main process's stdout. */
    printMessages?: boolean;
}

/**
 * The run configuration from the command line (the packaged app): the
 * launcher's options (-c, -d, -l, --devtools, --print-messages, --update,
 * --reset-bindings). Lenient, since Electron and the desktop may add flags of
 * their own (e.g. --no-sandbox); relative paths are the caller's.
 */
function argvConfig(): RunConfig & { resetBindings?: boolean } {
    const { values } = parseArgs({
        args: process.argv.slice(app.isPackaged ? 1 : 2),
        strict: false,
        allowPositionals: true,
        options: {
            command: { type: "string", short: "c" },
            dir: { type: "string", short: "d" },
            layout: { type: "string", short: "l" },
            devtools: { type: "boolean" },
            "print-messages": { type: "boolean" },
            update: { type: "boolean" },
            "reset-bindings": { type: "boolean" },
        },
    });
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);
    const dir = str(values.dir);
    const layout = str(values.layout);
    return {
        command: str(values.command),
        cwd: dir && resolve(dir),
        layout: layout && resolve(layout),
        devtools: values.devtools === true,
        printMessages: values["print-messages"] === true,
        update: values.update === true,
        resetBindings: values["reset-bindings"] === true,
    };
}

/**
 * The launcher's run configuration, if this process is the launcher's own
 * child: one inherited from further up (a shell of another buche window
 * starting the packaged app) is not for it.
 */
function launcherConfig(): RunConfig | undefined {
    const json = process.env.BUCHE_ELECTRON;
    // The shells started here (which may run `buche` themselves) must not
    // inherit it.
    delete process.env.BUCHE_ELECTRON;
    const config = json ? (JSON.parse(json) as RunConfig) : undefined;
    return config?.parent === process.ppid ? config : undefined;
}

const fromLauncher = launcherConfig();
const config: RunConfig & { resetBindings?: boolean } = fromLauncher ?? argvConfig();
// The bundle directory: handed over by the build script, or the packaged
// app's (`__dirname` is the source directory in a bun bundle).
const here = config.dir ?? app.getAppPath();

/**
 * The PATH of the user's login shell. An app started from the Dock, Finder
 * or a desktop launcher gets the session's bare PATH (on macOS, launchd's
 * /usr/bin:/bin:/usr/sbin:/sbin), without what the shell's startup files add
 * — where the shell may be. Interactive too, since PATH is often set in
 * ~/.zshrc or config.fish; the marker skips whatever those print.
 */
function loginShellPath(): string | undefined {
    const shell = process.env.SHELL || userInfo().shell || "/bin/sh";
    const marker = "__BUCHE_ENV__";
    const result = spawnSync(shell, ["-i", "-l", "-c", `echo ${marker}; env`], {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
    });
    const env = result.stdout?.split(marker)[1];
    const line = env?.split("\n").find((l) => l.startsWith("PATH="));
    return line ? line.slice("PATH=".length) : undefined;
}

// Not started from a terminal (the Dock, a launcher): the shell's PATH, and
// the home directory rather than / as the working directory.
if (!fromLauncher && !process.stdout.isTTY) {
    const path = loginShellPath();
    if (path) {
        process.env.PATH = path;
    }
}
if (config.cwd === undefined && process.cwd() === "/") {
    config.cwd = homedir();
}

// Outgoing/incoming driver messages, printed like scripts/view.ts does —
// hidden unless the run was started with --print-messages.
const pretty = Boolean(process.stdout.isTTY);
const width = process.stdout.columns || 80;
function logMessage(role: string, message: unknown): void {
    if (!config.printMessages) {
        return;
    }
    const tagged = { ...(message as object), $role: role };
    console.log(
        pretty
            ? formatMessage(tagged, { verbose: false, width, color: true })
            : JSON.stringify(tagged),
    );
}

// Everything after the scheme registration needs the app to be ready, and the
// bundle is CommonJS — hence the async entry point rather than top-level await.
async function start(): Promise<void> {
    // `proc:` must be privileged before the app is ready; the GUI runtime document
    // is written next to this bundle by the build script.
    registerProcScheme();
    setRuntimeHtml(readFileSync(join(here, "runtime.html"), "utf8"));

    // The defaults are copied next to the bundle by the build script.
    const defaultsPath = join(here, "default.yaml");
    if (config.resetBindings) {
        const { path, changed } = resetBindings(defaultsPath);
        console.log(
            changed
                ? `buche: ${path}: bindings reset to the defaults`
                : `buche: ${path}: no bindings of its own, nothing to reset`,
        );
        app.exit(0);
        return;
    }
    // What the page starts with (src/page.ts, `pageSetup`), asked for by the
    // preload before the renderer runs.
    const { user, defaults } = loadUserConfig(defaultsPath);
    let layout: unknown;
    if (config.layout) {
        try {
            layout = JSON.parse(readFileSync(config.layout, "utf8"));
        } catch (e) {
            console.error(`buche: ${config.layout}: ${(e as Error).message}`);
        }
    }
    ipcMain.on("page:setup", (event) => {
        event.returnValue = { layout, config: user, defaultConfig: defaults };
    });

    // The shell: its tools installed meanwhile (if it has some: the first run
    // downloads them), while the window opens.
    const shellConfig = resolveShell([defaults, user]);
    for (const error of shellConfig.errors) {
        console.error(`buche: config: ${error}`);
    }
    const shell = shellConfig.shell ?? { command: process.env.SHELL || "sh" };
    const command = config.command ?? expandHome(shell.command);
    const tools: Promise<ResolvedShell | Error> = resolveShellCommand(shell, {
        update: config.update,
    }).catch((e: Error) => e);

    await app.whenReady();

    // The default menu binds Cmd+W to "close window"; this one hands it to the
    // renderer instead (close the current tab — see src/interface.tsx). The
    // roles keep the usual shortcuts, which macOS routes through the menu
    // (copy/paste in particular). On macOS the accelerator is Cmd only, so
    // Ctrl+W reaches the page — prompts use it to delete a word, as in a shell.
    Menu.setApplicationMenu(
        Menu.buildFromTemplate([
            { role: "appMenu" },
            { role: "editMenu" },
            { role: "viewMenu" },
            {
                label: "Window",
                submenu: [
                    {
                        label: "Close Current Tab",
                        accelerator: process.platform === "darwin" ? "Cmd+W" : "CmdOrCtrl+W",
                        click: (_item, win) => {
                            if (win instanceof BrowserWindow && !win.isDestroyed()) {
                                win.webContents.send("window:closeTab");
                            }
                        },
                    },
                    {
                        // Unlike Cmd+Q (held: see guardQuit), right away. Nothing
                        // in the page can hold it open (no beforeunload); the
                        // window's processes die with it, and the app quits.
                        label: "Close Window Now",
                        // (Not Cmd+Shift+Q: macOS keeps that one for Log Out.)
                        accelerator:
                            process.platform === "darwin" ? "Cmd+Shift+W" : "CmdOrCtrl+Shift+W",
                        click: (_item, win) => {
                            if (win instanceof BrowserWindow && !win.isDestroyed()) {
                                win.destroy();
                            }
                        },
                    },
                    { role: "minimize" },
                    { role: "zoom" },
                    { role: "front" },
                ],
            },
        ]),
    );

    // The app icon (assets/buche.svg, rasterized by hand into buche.png and
    // copied next to the bundle by the build script; nativeImage only reads
    // SVG on Linux). The Dock tile on macOS — set before the window opens to
    // keep Electron's default icon from flashing — and the window's icon
    // elsewhere (macOS shows the Dock icon on windows regardless).
    const icon = nativeImage.createFromPath(join(here, "buche.png"));
    app.dock?.setIcon(icon); // (app.dock is macOS-only; the window icon below covers the rest.)

    const win = new BrowserWindow({
        width: 1280,
        height: 860,
        backgroundColor: "#141414",
        title: `buche — ${command}`,
        icon,
        webPreferences: {
            preload: join(here, "preload.cjs"),
        },
    });

    lockDownGuiFrames(win);
    initProcProtocol();
    setWebContents(win.webContents);
    // The libraries the drivers declare (src/library.ts), served at lib://.
    const libraries = new LibraryRegistry();
    initLibProtocol(libraries);
    // Renderer problems would otherwise only be visible in devtools. Electron's
    // dev-mode CSP lecture (which vanishes in a packaged app) is skipped.
    win.webContents.on("console-message", (event) => {
        if (
            (event.level === "error" || event.level === "warning") &&
            !event.message.includes("Electron Security Warning")
        ) {
            console.error(`[renderer:${event.level}] ${event.message}`);
        }
    });
    await win.loadFile(join(here, "index.html"));
    if (config.devtools) {
        win.webContents.openDevTools({ mode: "detach" });
    }

    // The window's driver processes (the first one, and the shells started
    // later: see src/drivers.ts); they die with the window, and the window
    // with them (like the WebSocket session of scripts/view.ts dies with its
    // socket). The window closes on the last one's raw exit — not on the
    // pipes reaching EOF, since a grandchild inheriting them could hold the
    // window open past the exit (e.g. after Ctrl+D closes the shell).
    let closed = false;
    const drivers = new Drivers({
        cwd: config.cwd,
        libraries,
        receive(message) {
            logMessage("driverIn", message);
            if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
                win.webContents.send("driver:message", message);
            }
        },
        exited: () => shutdown(),
    });
    // The tools first on PATH, for the shell and everything it runs. If they
    // could not be installed, the command is run anyway (it may be on PATH).
    const resolved = await tools;
    if (resolved instanceof Error) {
        const message = `${shell.github}: ${resolved.message}`;
        console.error(`buche: ${message}`);
        dialog.showErrorBox("buche: could not install the shell", message);
    } else if (resolved.binDir) {
        prependPath(resolved.binDir);
    }
    drivers.start(command);

    // The renderer's driver messages, to the driver each is for.
    ipcMain.on("driver:message", (_event, message: OutgoingDriverMessage) => {
        logMessage("driverOut", message);
        drivers.send(message);
    });

    // Window title changes from the renderer (Alt+Q T popup, see
    // src/components/title-editor.ts).
    ipcMain.on("window:title", (event, title: unknown) => {
        BrowserWindow.fromWebContents(event.sender)?.setTitle(String(title));
    });

    function shutdown(): void {
        if (closed) {
            return;
        }
        closed = true;
        drivers.kill();
        app.quit();
    }

    guardQuit(win);

    win.on("closed", shutdown);
    app.on("before-quit", shutdown);
    app.on("window-all-closed", shutdown);

    // Die with the launcher. Ctrl+C reaches Electron through the shared process
    // group, but a launcher killed by other means (SIGKILL, a crashed parent)
    // would otherwise orphan the window: on Unix an orphan is reparented, so a
    // ppid that stopped matching the launcher's means the launcher exited.
    if (config.parent !== undefined) {
        const parent = config.parent;
        const watch = setInterval(() => {
            if (process.ppid !== parent) {
                clearInterval(watch);
                app.quit();
            }
        }, 500);
        watch.unref();
    }
}

/**
 * No network for GUI frames (see src/csp.ts), at the network layer: the
 * backstop behind the CSP their documents carry, which also stops what CSP
 * can't, a frame navigating itself to an http(s) URL. Of the window's
 * requests, only its top-level page's (the shell, loaded from file:) may go
 * to http(s) or ws(s); a request from any other frame, or one that can't be
 * traced to a frame (a worker's, a frame already gone), is cancelled. Other
 * web contents (the devtools) are left alone.
 *
 * WebRTC escapes both layers. Short of disabling it, UDP is limited to what
 * goes through a proxy (none, normally): no STUN, so no direct peer traffic
 * (a TURN server over TCP would still be reachable).
 */
function lockDownGuiFrames(win: BrowserWindow): void {
    const wc = win.webContents;
    const outside = (details: OnBeforeRequestListenerDetails): boolean => {
        if (details.webContentsId !== wc.id) {
            return false;
        }
        const frame = details.frame;
        return details.resourceType === "subFrame" || frame == null || frame.parent !== null;
    };
    wc.session.webRequest.onBeforeRequest(
        { urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] },
        (details, callback) => {
            const cancel = outside(details);
            if (cancel) {
                console.error(`[buche] blocked a GUI request: ${details.url}`);
            }
            callback({ cancel });
        },
    );
    wc.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
}

/** How long Cmd+Q must be held to quit, in ms. */
const QUIT_HOLD = 1000;

/**
 * The OS key repeat timings, in ms: the delay before the first repeat and the
 * interval between repeats (macOS keeps them in units of 15 ms; elsewhere, or
 * when unset, typical values).
 */
function keyRepeat(): { delay: number; interval: number } {
    if (process.platform === "darwin") {
        const delay = systemPreferences.getUserDefault("InitialKeyRepeat", "integer");
        const interval = systemPreferences.getUserDefault("KeyRepeat", "integer");
        return { delay: (delay || 25) * 15, interval: (interval || 6) * 15 };
    }
    return { delay: 500, interval: 35 };
}

/**
 * Quitting takes holding Cmd+Q (Ctrl+Q off macOS) for QUIT_HOLD ms, so that a
 * stray press doesn't end the session. The press is taken from the menu (and
 * the page); the renderer shows a hint while it is held (`window:quitHint`,
 * see src/components/quit-hint.ts). Quitting from the menu with the mouse is
 * unaffected.
 *
 * The hold is tracked through key repeats, since macOS sends no keyup for a
 * key released while Cmd is still down: it ends on a keyup of Q or of the
 * modifier, on the window losing focus, or when the next repeat is overdue.
 */
function guardQuit(win: BrowserWindow): void {
    const mac = process.platform === "darwin";
    const margin = 150;
    let start = 0;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    let done: ReturnType<typeof setTimeout> | null = null;

    const hint = (state: "start" | "cancel") => {
        if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
            win.webContents.send("window:quitHint", { state, duration: QUIT_HOLD });
        }
    };
    const cancel = () => {
        if (!start) {
            return;
        }
        start = 0;
        if (watchdog) {
            clearTimeout(watchdog);
        }
        if (done) {
            clearTimeout(done);
        }
        watchdog = done = null;
        hint("cancel");
    };
    // The key counts as released when its next (repeat) keydown is overdue.
    const expectNext = (wait: number) => {
        if (watchdog) {
            clearTimeout(watchdog);
        }
        watchdog = setTimeout(cancel, wait + margin);
    };

    win.webContents.on("before-input-event", (event, input) => {
        const isQ = input.code === "KeyQ";
        const isMod = mac ? input.key === "Meta" : input.key === "Control";
        if (input.type === "keyUp") {
            if (isQ || isMod) {
                cancel();
            }
            return;
        }
        if (input.type !== "keyDown" || !isQ) {
            return;
        }
        const mod = mac ? input.meta && !input.control : input.control && !input.meta;
        if (!mod || input.alt || input.shift) {
            return;
        }
        // (Also keeps the menu's Quit accelerator from firing.)
        event.preventDefault();
        const { delay, interval } = keyRepeat();
        if (!start || !input.isAutoRepeat) {
            cancel();
            start = Date.now();
            hint("start");
            expectNext(delay);
            done = setTimeout(() => {
                if (start) {
                    app.quit();
                }
            }, QUIT_HOLD);
        } else {
            expectNext(interval);
        }
    });
    win.on("blur", cancel);
}

void start();
