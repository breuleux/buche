const { ipcMain, protocol } = require("electron");
const path = require("path");
const fs = require("fs");

const librariesByHash = new Map(); // buche://hash/<hash>/...
const librariesByNonce = new Map(); // buche://nonce/<nonce>/...

// proc:// protocol state
const procCache = new Map();         // Map<cellId, Map<path, {content, mimetype}>>
const pendingProcRequests = new Map(); // Map<requestId, {resolve, reject}>
let _webContents = null;

const PROC_RUNTIME_HTML = fs.readFileSync(
  path.join(__dirname, "cell", "data-runtime.html"),
  "utf8",
);

protocol.registerSchemesAsPrivileged([
  {
    scheme: "buche",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
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

function setWebContents(wc) {
  _webContents = wc;
}

ipcMain.on("library:store", (_event, { hash_function, hash, nonce, files }) => {
  if (hash) librariesByHash.set(hash, { hash_function, files });
  if (nonce) librariesByNonce.set(nonce, { files });
});

ipcMain.on("proc:cache", (_event, { cellId, path: resourcePath, content, mimetype, encoding }) => {
  if (!procCache.has(cellId)) procCache.set(cellId, new Map());
  procCache.get(cellId).set(resourcePath, { content, mimetype, encoding });
});

ipcMain.on("proc:response", (_event, { requestId, content, mimetype, status, encoding }) => {
  const pending = pendingProcRequests.get(requestId);
  if (pending) {
    pendingProcRequests.delete(requestId);
    pending.resolve({ content, mimetype, status, encoding });
  }
});

function registerProtocol() {
  protocol.handle("buche", (request) => {
    const url = new URL(request.url);
    const mode = url.hostname; // "hash" or "nonce"
    const [key, ...rest] = url.pathname.slice(1).split("/");
    const subpath = rest.join("/");
    const lib =
      mode === "hash"
        ? librariesByHash.get(key)
        : mode === "nonce"
          ? librariesByNonce.get(key)
          : undefined;
    if (!lib) return new Response("Library not found", { status: 404 });
    const file = lib.files[subpath] ?? lib.files["/" + subpath];
    if (!file) return new Response("File not found", { status: 404 });
    return new Response(file.content, {
      headers: { "content-type": file.mimetype },
    });
  });

  protocol.handle("proc", async (request) => {
    const url = new URL(request.url);
    const cellId = url.hostname;
    const resourcePath = url.pathname || "/";
    const method = request.method;

    if (resourcePath === "/" || resourcePath === "/index.html") {
      return new Response(PROC_RUNTIME_HTML, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    const cached = procCache.get(cellId)?.get(resourcePath);
    if (cached) {
      const body = cached.encoding === "base64"
      ? Buffer.from(cached.content, "base64")
      : cached.content;
      return new Response(body, {
        headers: { "content-type": cached.mimetype },
      });
    }

    if (!_webContents || _webContents.isDestroyed()) {
      return new Response("Not available", { status: 503 });
    }

    const requestId = Math.random().toString(36).slice(2);
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingProcRequests.delete(requestId);
        reject(new Error("proc:// request timeout"));
      }, 10000);
      pendingProcRequests.set(requestId, {
        resolve: (val) => { clearTimeout(timer); resolve(val); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
    });

    _webContents.send("proc:request", { requestId, cellId, path: resourcePath, method });

    try {
      const response = await promise;
      const body = response.encoding === "base64"
        ? Buffer.from(response.content ?? "", "base64")
        : (response.content ?? "");
      return new Response(body, {
        status: response.status ?? 200,
        headers: { "content-type": response.mimetype ?? "application/octet-stream" },
      });
    } catch {
      return new Response("Failed to resolve resource", { status: 502 });
    }
  });
}

module.exports = { registerProtocol, setWebContents };
