// Main-process glue for the `proc://` GUI resource protocol, the Electron
// counterpart of the runtime shim in <buche-gui> (see
// src/components/buche-gui-runtime.ts). This is the "native" version of the original
// ~/code/buche `src/terminal/file-protocol.js`, without the `buche://`
// hash/nonce library scheme.
//
// Wiring (in the Electron main process):
//
//   import { app, BrowserWindow } from "electron";
//   import { guiRuntimeDocument } from "../src/components/buche-gui-runtime.ts";
//   import { initProcProtocol, registerProcScheme, setRuntimeHtml, setWebContents } from "./proc-protocol.ts";
//
//   registerProcScheme(); // before app is ready
//   setRuntimeHtml(guiRuntimeDocument());
//   const win = await app.whenReady().then(() => new BrowserWindow({
//       webPreferences: { preload: path.join(__dirname, "preload.cjs") },
//   }));
//   initProcProtocol();
//   setWebContents(win.webContents);
//
// Requests the renderer's preload answers from its cache never leave main;
// cache misses are relayed to the renderer (`proc:request`) and awaited — the
// renderer routes them to the owning process (see `installGuiRelay` in
// src/interface.tsx) and answers through the preload (`proc:response`).

import { ipcMain, protocol, type WebContents } from "electron";

interface CachedResource {
    content: string;
    mimetype: string;
    encoding?: string | null;
}

// proc://<cell-id>/<path> resources pushed ahead of time.
const procCache = new Map<string, Map<string, CachedResource>>();
// In-flight requests relayed to the renderer.
const pendingProcRequests = new Map<
    string,
    { resolve: (v: ProcAnswer) => void; reject: (e: Error) => void }
>();

interface ProcAnswer {
    status?: number;
    content?: string;
    mimetype?: string;
    encoding?: string | null;
}

let runtimeHtml = "<!doctype html><html><body></body></html>";
let contents: WebContents | null = null;

/** The runtime document served at `proc://<cell-id>/` (the `html`-less GUI
 *  shell; see guiRuntimeDocument). */
export function setRuntimeHtml(html: string): void {
    runtimeHtml = html;
}

export function setWebContents(wc: WebContents): void {
    contents = wc;
}

/** Must run before the app is ready. */
export function registerProcScheme(): void {
    protocol.registerSchemesAsPrivileged([
        {
            scheme: "proc",
            privileges: {
                standard: true,
                secure: true,
                supportFetchAPI: true,
                corsEnabled: true,
            },
        },
    ]);
}

const bodyOf = (r: { content?: string; encoding?: string | null }): BodyInit =>
    r.encoding === "base64" ? Buffer.from(r.content ?? "", "base64") : (r.content ?? "");

export function initProcProtocol(): void {
    ipcMain.on(
        "proc:cache",
        (
            _event,
            {
                cellId,
                path,
                content,
                mimetype,
                encoding,
            }: CachedResource & { cellId: string; path: string },
        ) => {
            let cell = procCache.get(cellId);
            if (!cell) {
                cell = new Map();
                procCache.set(cellId, cell);
            }
            cell.set(path, { content, mimetype, encoding });
        },
    );

    ipcMain.on("proc:response", (_event, answer: ProcAnswer & { requestId: string }) => {
        const pending = pendingProcRequests.get(answer.requestId);
        if (pending) {
            pendingProcRequests.delete(answer.requestId);
            pending.resolve(answer);
        }
    });

    protocol.handle("proc", async (request) => {
        const url = new URL(request.url);
        const cellId = url.hostname;
        const resourcePath = url.pathname || "/";

        // The runtime document itself.
        if (resourcePath === "/" || resourcePath === "/index.html") {
            return new Response(runtimeHtml, {
                headers: { "content-type": "text/html; charset=utf-8" },
            });
        }

        const cached = procCache.get(cellId)?.get(resourcePath);
        if (cached) {
            return new Response(bodyOf(cached), {
                headers: { "content-type": cached.mimetype },
            });
        }

        if (!contents || contents.isDestroyed()) {
            return new Response("Not available", { status: 503 });
        }

        const requestId = Math.random().toString(36).slice(2);
        const answered = new Promise<ProcAnswer>((resolve, reject) => {
            const timer = setTimeout(() => {
                pendingProcRequests.delete(requestId);
                reject(new Error("proc:// request timeout"));
            }, 10_000);
            pendingProcRequests.set(requestId, {
                resolve: (v) => {
                    clearTimeout(timer);
                    resolve(v);
                },
                reject: (e) => {
                    clearTimeout(timer);
                    reject(e);
                },
            });
        });

        contents.send("proc:request", {
            requestId,
            cellId,
            path: resourcePath,
            method: request.method,
            params: Object.fromEntries(url.searchParams),
        });

        try {
            const answer = await answered;
            return new Response(bodyOf(answer), {
                status: answer.status ?? 200,
                headers: { "content-type": answer.mimetype ?? "application/octet-stream" },
            });
        } catch {
            return new Response("Failed to resolve resource", { status: 502 });
        }
    });
}
