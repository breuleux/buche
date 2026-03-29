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

contextBridge.exposeInMainWorld("buche", {
  vsBase: path.join(__dirname, "../node_modules/monaco-editor/min/vs"),
  onInstruction: (cb) => {
    onInstructionCb = cb;
    for (const instruction of pending) {
      cb(instruction);
    }
    pending.length = 0;
  },
  sendCommand: (obj) => ipcRenderer.send("command", obj),
});
