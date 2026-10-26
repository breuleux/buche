// Electron main process: the Electron counterpart of the WebSocket server in
// scripts/view.ts. It owns the driver process (typically the coquille shell)
// and relays its messages to the renderer, where the Buche core and the
// interface run (see electron/renderer.ts). It also registers the native
// `proc://` scheme for GUI cells (see electron/proc-protocol.ts).
//
// Not launched directly: `bun run electron` (scripts/electron.ts) builds the
// bundles, writes dist/electron/{index.html,renderer.js,preload.cjs,runtime.html}
// and starts Electron with this file, passing the run configuration in the
// BUCHE_ELECTRON environment variable as JSON: { command, cwd, devtools, printMessages }.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, ipcMain, Menu, systemPreferences } from "electron";
import { formatMessage } from "../scripts/format.ts";
import type { OutgoingDriverMessage } from "../src/driver-exchange/outgoing.ts";
import { Drivers } from "../src/drivers.ts";
import {
    initProcProtocol,
    registerProcScheme,
    setRuntimeHtml,
    setWebContents,
} from "./proc-protocol.ts";

interface RunConfig {
    /** Shell command driving the session. */
    command?: string;
    /** Pid of the launcher (scripts/electron.ts); the app quits when it dies. */
    parent?: number;
    /** The directory the build script wrote the bundles and pages into. */
    dir?: string;
    /** Working directory for the process. */
    cwd?: string;
    /** Open the devtools on start. */
    devtools?: boolean;
    /** Print the driver messages on the main process's stdout. */
    printMessages?: boolean;
}

const config: RunConfig = JSON.parse(process.env.BUCHE_ELECTRON ?? "{}") as RunConfig;
const command = config.command ?? "cq";
// The bundle directory, handed over by the build script (`__dirname` is the
// source directory in a bun bundle, and there is no reliable runtime handle
// on the bundle's own location).
const here = config.dir ?? __dirname;

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

    const win = new BrowserWindow({
        width: 1280,
        height: 860,
        backgroundColor: "#141414",
        title: `buche — ${command}`,
        webPreferences: {
            preload: join(here, "preload.cjs"),
        },
    });

    initProcProtocol();
    setWebContents(win.webContents);
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
        receive(message) {
            logMessage("driverIn", message);
            if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
                win.webContents.send("driver:message", message);
            }
        },
        exited: () => shutdown(),
    });
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
