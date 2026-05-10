import { buchekeys } from "./buchekeys.js";
import { AutoHandler } from "./cell/auto.js";
import { Cell } from "./cell/cell.js";
import { DataHandler } from "./cell/data.js";
import { TermHandler } from "./cell/term.js";
import { TextHandler } from "./cell/text.js";
import { isPromptFocused } from "./prompt.js";
import { ZoneManager } from "./zone.js";
import { html, addressMatchesProcess } from "./utils.js";
import "./scroll-fader.js";

// ── Zone manager ─────────────────────────────────────────────────────────

const zonesContainer = document.getElementById("zones-container");

const cellHandlers = {
  text: TextHandler,
  term: TermHandler,
  auto: AutoHandler,
  data: DataHandler,
};

// Stable string key from an address object + a local name.
function cellKey(address, name) {
  return JSON.stringify(address) + ":" + name;
}

class CellBridge {
  constructor(executor, instruction) {
    this.executor = executor;
    this.instruction = instruction;
  }
  sendInput(arg) {
    this.executor.bridge.sendCommand(
      typeof arg === "string"
        ? { type: "input", to: this.instruction.address, text: arg }
        : { type: "input", to: this.instruction.address, data: arg },
    );
  }
  sendResize(cols, rows) {
    this.executor.bridge.sendCommand({
      type: "pty_resize",
      to: this.instruction.address,
      cols,
      rows,
    });
  }
  sendControl(arg) {
    console.log({ ...arg, to: this.instruction.address });
    this.executor.bridge.sendCommand({ ...arg, to: this.instruction.address });
  }
  onBackground() {
    this.executor._activeCell = null;
    const key = cellKey(this.instruction.address, this.instruction.to.cell);
    const zoneName = this.executor.cells.get(key)?.zone ?? "main";
    this.executor._zoneManager.focusZone(zoneName);
  }
}

class Executor {
  constructor(bridge) {
    // Map<key, {cell: Cell, address: object, zone: string}>
    this.cells = new Map();
    this._activeCell = null;
    this.bridge = bridge;
    this._zoneManager = new ZoneManager(zonesContainer, bridge);
    this._zoneManager.onFloatBlur = (zoneName, baseZoneName) => {
      for (const [key, entry] of [...this.cells]) {
        if (entry.zone === zoneName) {
          if (entry.cell.isAlive()) entry.cell.kill();
          entry.cell.node.remove();
          this.cells.delete(key);
          if (this._activeCell === key) this._activeCell = null;
        }
      }
      // Also remove nodes already closed by process_close (no longer in this.cells).
      this._zoneManager.clearZoneBuffer(zoneName);
      this._zoneManager.focusZone(baseZoneName);
    };
    this.bridge.onInstruction((instruction) => this.execute(instruction));
  }

  execute(instruction) {
    const handler = this[`handle$${instruction.type}`];
    if (handler) {
      handler.call(this, instruction);
    }
  }

  handle$cell_create(instruction) {
    const key = cellKey(instruction.address, instruction.to.cell);
    if (this.cells.has(key)) {
      console.error("Cell already exists:", key);
      return;
    }
    const HandlerClass = cellHandlers[instruction.mode];
    if (!HandlerClass) {
      console.error("Unknown mode:", instruction.mode);
      return;
    }
    let echo = null;
    if (instruction.echo_html) {
      const div = document.createElement("div");
      div.innerHTML = instruction.echo_html;
      echo = div.firstChild;
    }
    const bridge = new CellBridge(this, instruction);
    const cell = new Cell(instruction, echo, HandlerClass, bridge);
    const zone = this._zoneManager.resolveZone(instruction.zone ?? "main");
    zone.prepareForCell?.();
    zone.buffer.appendChild(cell.node);
    this.cells.set(key, { cell, address: instruction.address, zone: zone.name });
    if (!instruction.background) {
      this._activeCell = key;
      cell.node.focus();
    }
  }

  handle$cell_send(instruction) {
    this.cells
      .get(cellKey(instruction.address, instruction.to.cell))
      ?.cell.send(instruction.message);
  }

  handle$send(instruction) {
    const cell = this.cells.get(
      cellKey(instruction.address, instruction.to.cell),
    )?.cell;
    if (instruction.data) {
      cell.send({
        type: "data",
        data: instruction.data,
        stream: instruction.stream,
      });
    } else if (instruction.text) {
      cell.send({
        type: "text",
        text: instruction.text,
        stream: instruction.stream,
      });
    }
  }

  handle$cell_close(instruction) {
    const key = cellKey(instruction.address, instruction.to.cell);
    const entry = this.cells.get(key);
    if (entry) {
      const isFocused = entry.cell.node === document.activeElement;
      entry.cell.close(instruction.return_code);
      this.cells.delete(key);
      if (this._activeCell === key) {
        this._activeCell = null;
        if (isFocused) {
          this._zoneManager.focusZone(entry.zone);
        }
      } else if (isFocused) {
        this._zoneManager.focusZone(entry.zone);
      }
    }
  }

  handle$process_close(instruction) {
    const { process_id } = instruction;
    let anyFocused = false;
    let closedZone = null;
    for (const [key, entry] of [...this.cells]) {
      if (addressMatchesProcess(entry.address, process_id)) {
        if (entry.cell.node === document.activeElement) anyFocused = true;
        closedZone = entry.zone;
        entry.cell.close(instruction.return_code);
        this.cells.delete(key);
        if (this._activeCell === key) this._activeCell = null;
      }
    }
    this._zoneManager.removePromptsByProcess(process_id);
    if (anyFocused || this._activeCell === null) {
      this._zoneManager.focusZone(closedZone ?? "main");
    }
  }

  handle$prompt_create(instruction) {
    this._zoneManager.addPrompt(instruction);
  }

  handle$set_prompt(instruction) {
    this._zoneManager.setPrompt(instruction);
  }

  handle$highlight(instruction) {
    this._zoneManager.applyHighlight(instruction);
  }

  handle$complete(instruction) {
    this._zoneManager.applyComplete(instruction);
  }

  clearInactiveCells() {
    const activeNodes = new Set([...this.cells.values()].map((e) => e.cell.node));
    for (const zone of this._zoneManager.allZones()) {
      for (const child of [...zone.buffer.children]) {
        if (!activeNodes.has(child)) {
          child.remove();
        }
      }
    }
  }

  handle$library(instruction) {
    const { hash_function, hash, nonce, files } = instruction;
    window.buche.storeLibrary({ hash_function, hash, nonce, files });
  }

  handle$error(instruction) {
    const traceback = (instruction.traceback || []).map(
      (line) => html`<div class="error-traceback-line">${line}</div>`,
    );
    const cell = html`
      <div class="cell cell-error">
        <pre class="error-header">${instruction.error_type}: ${instruction.message}</pre>
        ${traceback.length ? html`<div class="error-traceback">${traceback}</div>` : null}
      </div>`;
    // Route error cells to the main zone buffer
    this._zoneManager.resolveZone("main").buffer.appendChild(cell);
  }
}

const _executor = new Executor(window.buche);

// ── Cell navigation helpers ──────────────────────────────────────────────

function getOrderedCellNodes() {
  return [..._executor._zoneManager.allZones()].flatMap((zone) =>
    [...zone.buffer.children].filter((n) => n.classList.contains("cell")),
  );
}

function focusCellNode(node) {
  node.focus();
}

function getFocusedCellEntry() {
  const cellNode = document.activeElement?.closest?.(".cell");
  if (!cellNode) return null;
  return [..._executor.cells.values()].find((e) => e.cell.node === cellNode) ?? null;
}

// ── Global key bindings ──────────────────────────────────────────────────

buchekeys(window, {
  "Control+l": (e) => {
    if (!isPromptFocused()) return;
    e.preventDefault();
    _executor.clearInactiveCells();
  },

  // C-q prefix mode bindings
  "Control+q ~ ArrowUp": (e) => {
    const ordered = getOrderedCellNodes();
    if (ordered.length === 0) return;
    const focused = document.activeElement?.closest?.(".cell");
    if (!focused || !ordered.includes(focused)) {
      focusCellNode(ordered[ordered.length - 1]);
      return;
    }
    const idx = ordered.indexOf(focused);
    if (idx > 0) focusCellNode(ordered[idx - 1]);
  },

  "Control+q ~ ArrowDown": (e) => {
    const ordered = getOrderedCellNodes();
    if (ordered.length === 0) return;
    const focused = document.activeElement?.closest?.(".cell");
    if (!focused || !ordered.includes(focused)) return;
    const idx = ordered.indexOf(focused);
    if (idx === ordered.length - 1) {
      const entry = getFocusedCellEntry();
      _executor._zoneManager.focusZone(entry?.zone ?? "main");
    } else {
      focusCellNode(ordered[idx + 1]);
    }
  },

  "Control+q ~ k": (e) => {
    const entry = getFocusedCellEntry();
    if (entry?.cell.isAlive()) entry.cell.kill();
  },

  "Control+q ~ Shift+K": (e) => {
    const entry = getFocusedCellEntry();
    if (entry?.cell.isAlive()) entry.cell.kill("SIGKILL");
  },

  "Control+q ~ Alt+ArrowUp": (e) => {
    const cellNode = document.activeElement?.closest?.(".cell");
    if (!cellNode) return;
    const prev = cellNode.previousElementSibling;
    if (prev?.classList.contains("cell")) {
      cellNode.parentElement.insertBefore(cellNode, prev);
      cellNode.scrollIntoView({ block: "nearest" });
    }
  },

  "Control+q ~ Alt+ArrowDown": (e) => {
    const cellNode = document.activeElement?.closest?.(".cell");
    if (!cellNode) return;
    const next = cellNode.nextElementSibling;
    if (next?.classList.contains("cell")) {
      cellNode.parentElement.insertBefore(next, cellNode);
      cellNode.scrollIntoView({ block: "nearest" });
    }
  },

  "Control+q ~ f": (e) => {
    const cellNode = document.activeElement?.closest?.(".cell");
    if (!cellNode) return;
    cellNode.parentElement.appendChild(cellNode);
    cellNode.scrollIntoView({ block: "nearest" });
    const entry = getFocusedCellEntry();
    _executor._zoneManager.focusZone(entry?.zone ?? "main");
  },

  "Control+q ~ l": (e) => {
    _executor.clearInactiveCells();
    const entry = getFocusedCellEntry();
    _executor._zoneManager.focusZone(entry?.zone ?? "main");
  },

  "Control+q ~ p": (e) => {
    const entry = getFocusedCellEntry();
    _executor._zoneManager.focusZone(entry?.zone ?? "main");
  },

  "Control+Tab": (e) => {
    e.preventDefault();
    _executor._zoneManager.cycleTab(+1);
  },

  "Control+Shift+Tab": (e) => {
    e.preventDefault();
    _executor._zoneManager.cycleTab(-1);
  },

  "$mod+Shift+ArrowLeft": (e) => {
    e.preventDefault();
    _executor._zoneManager.moveToGroup(-1);
  },

  "$mod+Shift+ArrowRight": (e) => {
    e.preventDefault();
    _executor._zoneManager.moveToGroup(+1);
  },

  "Control+q ~ Control+q": (e) => { /* cancel prefix mode */ },
  "Control+q ~ Escape": (e) => { /* cancel prefix mode */ },

  "Control+q ~ d": (e) => {
    const cellNode = document.activeElement?.closest?.(".cell");
    if (!cellNode) return;
    const allCells = getOrderedCellNodes();
    const idx = allCells.indexOf(cellNode);
    const nextFocus = allCells[idx + 1] ?? null;
    let key = null;
    let zone = "main";
    for (const [k, entry] of _executor.cells) {
      if (entry.cell.node === cellNode) { key = k; zone = entry.zone; break; }
    }
    if (key) {
      const { cell } = _executor.cells.get(key);
      if (cell.isAlive()) cell.kill();
      cell.node.remove();
      _executor.cells.delete(key);
      if (_executor._activeCell === key) _executor._activeCell = null;
    } else {
      cellNode.remove();
    }
    if (nextFocus?.isConnected) {
      focusCellNode(nextFocus);
    } else {
      _executor._zoneManager.focusZone(zone);
    }
  },
});
