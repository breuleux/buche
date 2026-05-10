const { ipcMain, protocol } = require("electron");

const librariesByHash = new Map(); // buche://hash/<hash>/...
const librariesByNonce = new Map(); // buche://nonce/<nonce>/...

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
]);

ipcMain.on("library:store", (_event, { hash_function, hash, nonce, files }) => {
  if (hash) librariesByHash.set(hash, { hash_function, files });
  if (nonce) librariesByNonce.set(nonce, { files });
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
}

module.exports = { registerProtocol };
