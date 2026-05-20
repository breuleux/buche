import { buchekeys } from "./buchekeys.js";
import { setIframeKeysConfig } from "./iframekeys.js";
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
    // Echo elements emitted to the source zone when output is redirected via @left/@right/@tab.
    // handle$echo sets this; handle$cell_create consumes it immediately after (same event sequence).
    this._pendingEchoElements = null; // {statusDot, btnBar} | null
    // Maps cellKey → {statusDot} so close events can update the echo's indicator.
    this._cellEchoElements = new Map();
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

    // Consume the echo elements emitted just before this cell_create.
    const echoElements = this._pendingEchoElements;
    this._pendingEchoElements = null;

    const bridge = new CellBridge(this, instruction);
    if (echoElements) bridge.echoElements = echoElements;
    const cell = new Cell(instruction, echo, HandlerClass, bridge);

    if (echoElements) {
      echoElements.node.dataset.cellKey = key;
      echoElements.node._linkedCellNode = cell.node; // survives cell entry removal
      this._cellEchoElements.set(key, echoElements);
    }
    const zone = this._zoneManager.resolveZone(instruction.zone ?? "main", instruction.address?.process);
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
      this._closeEchoStatus(key, instruction.return_code);
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

  _closeEchoStatus(key, return_code) {
    const echoEls = this._cellEchoElements.get(key);
    if (!echoEls) return;
    echoEls.statusDot.className = `cell-status ${return_code === 0 ? "cell-status-success" : "cell-status-error"}`;
    this._cellEchoElements.delete(key);
  }

  handle$process_close(instruction) {
    const { process_id } = instruction;
    let anyFocused = false;
    let closedZone = null;
    for (const [key, entry] of [...this.cells]) {
      if (addressMatchesProcess(entry.address, process_id)) {
        this._closeEchoStatus(key, instruction.return_code);
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
    const activeEchoNodes = new Set([...this._cellEchoElements.values()].map((e) => e.node));
    for (const zone of this._zoneManager.allZones()) {
      for (const child of [...zone.buffer.children]) {
        if (!activeNodes.has(child) && !activeEchoNodes.has(child)) {
          child.remove();
        }
      }
    }
  }

  handle$library(instruction) {
    const { hash_function, hash, nonce, files } = instruction;
    window.buche.storeLibrary({ hash_function, hash, nonce, files });
  }

  handle$echo(instruction) {
    if (!instruction.echo_html) return;
    const inner = document.createElement("div");
    inner.innerHTML = instruction.echo_html;
    const statusDot = html`<div class="cell-status cell-status-running"></div>`;
    const btnBar = html`<span class="cell-btn-bar"></span>`;
    const el = html`<div class="cell-echo" tabindex="0">
      ${statusDot}
      <div class="cell-header">${inner.firstChild}<span class="cell-controls">${btnBar}</span></div>
    </div>`;
    this._pendingEchoElements = { statusDot, btnBar, node: el };
    this._zoneManager.resolveZone(instruction.zone ?? "main").buffer.appendChild(el);
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

// Returns navigable nodes (cells + echoes) in the active zone's buffer, in DOM order.
function getOrderedCellNodes() {
  const activeZone = _executor._zoneManager._zones.get(_executor._zoneManager._activeZoneName);
  if (!activeZone) return [];
  return [...activeZone.buffer.children].filter(
    (n) => n.classList.contains("cell") || n.classList.contains("cell-echo"),
  );
}

function focusCellNode(node) {
  node.focus();
}

// Directly focuses the active zone's prompt, bypassing activateByName's
// "don't steal from focused cell" guard. Used by explicit "return to prompt" actions.
function focusActivePrompt() {
  const zoneName = _executor._zoneManager._activeZoneName;
  const zone = _executor._zoneManager._zones.get(zoneName);
  if (zone?.promptCollection._prompts.length > 0) {
    zone.promptCollection.focus();
  } else {
    _executor._zoneManager._zones.get("main")?.promptCollection.focus();
  }
}

// Returns the focused .cell or .cell-echo node, whichever applies.
function getFocusedNavigableNode() {
  const el = document.activeElement;
  return el?.closest?.(".cell") ?? el?.closest?.(".cell-echo") ?? null;
}

// Returns the Executor cell entry for the focused navigable node.
// For .cell-echo nodes, looks up the linked cell via dataset.cellKey.
function getFocusedCellEntry() {
  const el = document.activeElement;
  const cellNode = el?.closest?.(".cell");
  if (cellNode) {
    return [..._executor.cells.values()].find((e) => e.cell.node === cellNode) ?? null;
  }
  const echoNode = el?.closest?.(".cell-echo");
  if (echoNode?.dataset.cellKey) {
    return _executor.cells.get(echoNode.dataset.cellKey) ?? null;
  }
  return null;
}

// ── Global key bindings ──────────────────────────────────────────────────

// These fire in the capture phase so they work regardless of what handlers
// child elements define (e.g. terminal input cells that stop propagation).
// The returned config is forwarded to data: iframes so they can mirror the same bindings.
const { config: _globalKeysConfig } = buchekeys(window, {
  // C-q prefix mode bindings
  "Control+q ~ ArrowUp": (e) => {
    const ordered = getOrderedCellNodes();
    if (ordered.length === 0) return;
    const focused = getFocusedNavigableNode();
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
    const focused = getFocusedNavigableNode();
    if (!focused || !ordered.includes(focused)) return;
    const idx = ordered.indexOf(focused);
    if (idx === ordered.length - 1) {
      focusActivePrompt();
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
    const node = getFocusedNavigableNode();
    if (!node) return;
    const prev = node.previousElementSibling;
    if (prev && (prev.classList.contains("cell") || prev.classList.contains("cell-echo"))) {
      node.parentElement.insertBefore(node, prev);
      node.scrollIntoView({ block: "nearest" });
    }
  },

  "Control+q ~ Alt+ArrowDown": (e) => {
    const node = getFocusedNavigableNode();
    if (!node) return;
    const next = node.nextElementSibling;
    if (next && (next.classList.contains("cell") || next.classList.contains("cell-echo"))) {
      node.parentElement.insertBefore(next, node);
      node.scrollIntoView({ block: "nearest" });
    }
  },

  "Control+q ~ f": (e) => {
    const node = getFocusedNavigableNode();
    if (!node) return;
    node.parentElement.appendChild(node);
    node.scrollIntoView({ block: "nearest" });
    focusActivePrompt();
  },

  "Control+q ~ l": (e) => {
    _executor.clearInactiveCells();
    focusActivePrompt();
  },

  "Control+q ~ p": (e) => {
    focusActivePrompt();
  },

  "Control+q ~ Control+q": (e) => { /* cancel prefix mode */ },
  "Control+q ~ Escape": (e) => { /* cancel prefix mode */ },

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

  "Control+q ~ d": (e) => {
    const focused = getFocusedNavigableNode();
    if (!focused) return;
    const allCells = getOrderedCellNodes();
    const idx = allCells.indexOf(focused);
    const nextFocus = allCells[idx + 1] ?? null;
    const activeZoneName = _executor._zoneManager._activeZoneName;

    const isEcho = focused.classList.contains("cell-echo");
    const key = isEcho
      ? (focused.dataset.cellKey ?? null)
      : ([..._executor.cells].find(([, e]) => e.cell.node === focused)?.[0] ?? null);

    if (key) {
      const entry = _executor.cells.get(key);
      if (entry) {
        if (entry.cell.isAlive()) entry.cell.kill();
        entry.cell.node.remove();
        _executor.cells.delete(key);
        if (_executor._activeCell === key) _executor._activeCell = null;
      } else if (isEcho) {
        // Cell already completed: entry is gone but node may still be in another zone's buffer.
        focused._linkedCellNode?.remove();
      }
      // Remove echo node. After cell completion _cellEchoElements is already cleared,
      // so fall back to the focused node itself.
      const echoEls = _executor._cellEchoElements.get(key);
      if (echoEls) { echoEls.node.remove(); _executor._cellEchoElements.delete(key); }
      else if (isEcho) focused.remove();
    } else {
      focused.remove();
    }

    if (nextFocus?.isConnected) {
      focusCellNode(nextFocus);
    } else {
      _executor._zoneManager.focusZone(activeZoneName);
    }
  },
}, { capture: true });
setIframeKeysConfig(_globalKeysConfig);

buchekeys(window, {
  "Control+l": (e) => {
    if (!isPromptFocused()) return;
    e.preventDefault();
    _executor.clearInactiveCells();
  },
});
