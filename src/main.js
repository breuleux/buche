const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const readline = require("readline");
const { spawn } = require("child_process");

const args = JSON.parse(process.env.BUCHE_OPTS ?? "{}");
const termdir = path.join(__dirname, "terminal");

const HISTORY_FILE = path.join(
  os.homedir(),
  ".config",
  "buche",
  "history.jsonl",
);

function loadHistory() {
  try {
    return fs
      .readFileSync(HISTORY_FILE, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function appendHistory(entry) {
  fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
  fs.appendFileSync(HISTORY_FILE, JSON.stringify(entry) + "\n");
}

ipcMain.handle("history:get", () => loadHistory());
ipcMain.on("history:add", (_event, entry) => appendHistory(entry));

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      preload: path.join(termdir, "preload.js"),
    },
  });

  win.loadFile(path.join(termdir, "index.html"));

  if (args.devtools) {
    win.webContents.openDevTools({ mode: "right" });
  }

  const cqBin = path.join(__dirname, "..", "bin", "cq.js");
  const cq = spawn(process.execPath, [cqBin], {
    stdio: ["ignore", "pipe", "pipe", "ignore", "ignore", "pipe"],
    env: { ...process.env, BUCHE_CONTROL_FD: "5" },
  });

  cq.stdout.pipe(process.stdout);
  cq.stderr.pipe(process.stderr);

  const fd5 = cq.stdio[5];

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

  function sendToShell(obj) {
    fd5.write(`${JSON.stringify(obj)}\n`);
  }

  ipcMain.on("command", (_event, obj) => {
    recordCommand(obj);
    sendToShell(obj);
  });

  if (args.startCommand) {
    sendToShell({ type: "parse", text: args.startCommand });
  }

  win.webContents.once("did-finish-load", () => {
    readline
      .createInterface({ input: fd5, crlfDelay: Infinity })
      .on("line", (line) => {
        try {
          win.webContents.send("instruction", JSON.parse(line));
        } catch {}
      });
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
