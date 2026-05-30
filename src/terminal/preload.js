const { contextBridge, ipcRenderer } = require("electron");
const path = require("node:path");

const pending = [];
let onInstructionCb = null;

ipcRenderer.on("instruction", (_event, instruction) => {
  if (onInstructionCb) {
    onInstructionCb(instruction);
  } else {
    pending.push(instruction);
  }
});

// Forward proc:// resource requests to the renderer via window.postMessage.
// Using postMessage avoids passing function arguments across the contextBridge
// (structured clone), which would throw "An object could not be cloned".
ipcRenderer.on("proc:request", (_event, msg) => {
  window.postMessage({ __buche: "proc:request", ...msg }, "*");
});

contextBridge.exposeInMainWorld("buche", {
  onInstruction: (cb) => {
    onInstructionCb = cb;
    for (const instruction of pending) {
      cb(instruction);
    }
    pending.length = 0;
  },
  sendCommand: (obj) => ipcRenderer.send("command", obj),
  history: {
    get: () => ipcRenderer.invoke("history:get"),
    add: (entry) => ipcRenderer.send("history:add", entry),
  },
  storeLibrary: (lib) => ipcRenderer.send("library:store", lib),
  proc: {
    respond: (requestId, status, content, mimetype, encoding) =>
      ipcRenderer.send("proc:response", { requestId, status, content, mimetype, encoding }),
    cache: (cellId, resourcePath, content, mimetype, encoding) =>
      ipcRenderer.send("proc:cache", { cellId, path: resourcePath, content, mimetype, encoding }),
  },
});
