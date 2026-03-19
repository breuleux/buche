const { contextBridge, ipcRenderer } = require('electron');
const path = require('path');

contextBridge.exposeInMainWorld('buche', {
  vsBase: path.join(__dirname, '../node_modules/monaco-editor/min/vs'),
  onInstruction: (cb) => ipcRenderer.on('instruction', (_event, instruction) => cb(instruction)),
});
