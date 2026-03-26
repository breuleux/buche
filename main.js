const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { Shell } = require("./src/shell");

const historyFile = path.join(
  os.homedir(),
  ".config",
  "buche",
  "history.jsonl",
);

function loadHistory() {
  try {
    return fs
      .readFileSync(historyFile, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l).text);
  } catch {
    return [];
  }
}

function appendHistory(text) {
  fs.mkdirSync(path.dirname(historyFile), { recursive: true });
  fs.appendFileSync(historyFile, JSON.stringify({ text }) + "\n");
}

ipcMain.handle("history:get", () => loadHistory());
ipcMain.on("history:add", (_event, text) => appendHistory(text));

const args = JSON.parse(process.env.BUCHE_OPTS ?? "{}");

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      preload: path.join(__dirname, "src", "preload.js"),
    },
  });

  win.loadFile("src/index.html");

  if (args.devtools) {
    win.webContents.openDevTools({ mode: "right" });
  }

  const shell = new Shell();
  const inputQueue = [];
  let inputResolve = null;

  let recordLastTime = null;
  if (args.record) {
    fs.writeFileSync(args.record, "");
  }

  function recordCommand(obj) {
    if (!args.record) return;
    const now = Date.now();
    if (recordLastTime !== null) {
      const seconds = parseFloat(((now - recordLastTime) / 1000).toFixed(3));
      if (seconds >= 0.1) {
        fs.appendFileSync(
          args.record,
          JSON.stringify({ type: "wait", seconds }) + "\n",
        );
      }
    }
    recordLastTime = now;
    fs.appendFileSync(args.record, JSON.stringify(obj) + "\n");
  }

  ipcMain.on("command", (_event, obj) => {
    recordCommand(obj);
    inputQueue.push(obj);
    if (inputResolve) {
      const r = inputResolve;
      inputResolve = null;
      r();
    }
  });

  async function* shellInput() {
    while (true) {
      while (inputQueue.length > 0) yield inputQueue.shift();
      await new Promise((r) => {
        inputResolve = r;
      });
    }
  }

  win.webContents.once("did-finish-load", () => {
    (async () => {
      for await (const instruction of shell.run(shellInput())) {
        win.webContents.send("instruction", instruction);
      }
    })();
  });

  if (args.replay) {
    win.webContents.once("did-finish-load", () => {
      const lines = fs
        .readFileSync(args.replay, "utf8")
        .split("\n")
        .filter((l) => l.trim());
      lines.forEach((line, i) => {
        setTimeout(() => {
          try {
            win.webContents.send("instruction", JSON.parse(line));
          } catch (e) {
            console.error("Bad JSON on line", i + 1, e.message);
          }
        }, i * 80);
      });
    });
  }
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
