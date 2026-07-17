// Renderer preload for the `proc://` protocol (counterpart of
// electron/proc-protocol.ts), the equivalent of the original
// ~/code/buche `src/terminal/preload.js` proc parts.
//
// `proc:request` notifications from the main process are forwarded as window
// messages (postMessage avoids passing functions through the contextBridge,
// which would throw "An object could not be cloned"); src/interface.tsx picks
// them up and routes them to the owning process. Answering goes the other
// way: <buche-gui> calls `window.buche.proc.respond` (see the preload-bridge
// detection in src/components/buche-gui.tsx).

import { contextBridge, ipcRenderer } from "electron";

ipcRenderer.on("proc:request", (_event, msg: Record<string, unknown>) => {
    window.postMessage({ __buche: "proc:request", ...msg }, "*");
});

// The driver bridge (electron/main.ts ⇄ electron/renderer.ts): incoming driver
// messages are posted to the page, outgoing ones go through `window.buche.driver`.
ipcRenderer.on("driver:message", (_event, message: unknown) => {
    window.postMessage({ __buche: "driver:message", message }, "*");
});

// The menu's Cmd+W (close the current tab, see electron/main.ts): posted to
// the page, where the interface handles it (src/interface.tsx).
ipcRenderer.on("window:closeTab", () => {
    window.postMessage({ __buche: "window:closeTab" }, "*");
});

contextBridge.exposeInMainWorld("buche", {
    driver: {
        send: (message: unknown) => ipcRenderer.send("driver:message", message),
    },
    window: {
        // Rename the window (C-q-t popup, src/components/title-editor.ts).
        setTitle: (title: string) => ipcRenderer.send("window:title", title),
    },
    proc: {
        respond: (
            requestId: string,
            status: number,
            content: string,
            mimetype: string,
            encoding?: string | null,
        ) => ipcRenderer.send("proc:response", { requestId, status, content, mimetype, encoding }),
        cache: (
            cellId: string,
            path: string,
            content: string,
            mimetype: string,
            encoding?: string | null,
        ) => ipcRenderer.send("proc:cache", { cellId, path, content, mimetype, encoding }),
    },
});
