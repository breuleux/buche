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

// Recursively strip fields that are null, undefined, or empty objects.
// Returns undefined if the value itself should be dropped.
function normalizeAddress(val) {
  if (val === null || val === undefined) return undefined;
  if (typeof val !== "object" || Array.isArray(val)) return val;
  const result = {};
  for (const [k, v] of Object.entries(val)) {
    const n = normalizeAddress(v);
    if (n !== undefined) result[k] = n;
  }
  return Object.keys(result).length === 0 ? undefined : result;
}

// Stable string key from an address object + a local name.
function cellKey(address, name) {
  return JSON.stringify(normalizeAddress(address) ?? {}) + ":" + name;
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
  onFocus() {
    this._cell?.onFocus?.();
  }

  onBackground() {
    this.executor._activeCell = null;
    const key = cellKey(this.instruction.address, this.instruction.to.cell);
    const zoneName = this.executor.cells.get(key)?.zone ?? "main";
    const zone = this.executor._zoneManager._zones.get(zoneName);
    if (zone) zone._latentFocusIsPrompt = true;
    this.executor._zoneManager.focusZone(zoneName);
  }

  killAndDelete() {
    const key = cellKey(this.instruction.address, this.instruction.to.cell);
    const executor = this.executor;
    const entry = executor.cells.get(key);
    const cellNode = this._cell.node;
    const allCells = getOrderedCellNodes();
    const idx = allCells.indexOf(cellNode);
    const nextFocus = allCells[idx + 1] ?? null;
    const activeZoneName = executor._zoneManager._activeZoneName;
    if (entry) {
      if (entry.cell.isAlive()) entry.cell.kill();
      executor.cells.delete(key);
      if (executor._activeCell === key) executor._activeCell = null;
    }
    cellNode.remove();
    const echoEls = executor._cellEchoElements.get(key);
    if (echoEls) { echoEls.node.remove(); executor._cellEchoElements.delete(key); }
    if (nextFocus?.isConnected) {
      focusCellNode(nextFocus);
    } else {
      executor._zoneManager.focusZone(activeZoneName);
    }
  }
}

let _cellCounter = 0;

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
          // Do NOT delete from this.cells — handle$cell_close / handle$process_close
          // must still run to call _closeEchoStatus and turn the status dot grey.
          if (this._activeCell === key) this._activeCell = null;
        }
      }
      // Remove nodes already closed by process_close (no longer in this.cells).
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
    bridge._cell = cell;
    const promptColor = instruction.prompt_color ?? null;
    cell.promptColor = promptColor;
    cell.node._promptColor = promptColor;
    cell.node._cellLabel = `cell-${++_cellCounter}`;

    if (echoElements) {
      echoElements.node.dataset.cellKey = key;
      echoElements.node._linkedCellNode = cell.node; // survives cell entry removal
      this._cellEchoElements.set(key, echoElements);
    }
    const zone = this._zoneManager.resolveZone(instruction.zone ?? "main", instruction.address?.process);
    if (promptColor) zone._promptColor = promptColor;
    cell.onFocus = () => this._zoneManager._setFocusedZone(zone.name);
    zone.prepareForCell?.();
    zone.buffer.appendChild(cell.node);
    this.cells.set(key, { cell, address: instruction.address, zone: zone.name, sticky: instruction.sticky ?? false });
    if (!instruction.background) {
      this._activeCell = key;
      cell.node.focus();
    }
  }

  handle$cell_send(instruction) {
    const key = cellKey(instruction.address, instruction.to.cell);
    const cellRef = this.cells.get(key);
    if (!cellRef) {
      console.error(`Could not find cell: ${key}`);
      return;
    }
    cellRef.cell.send(instruction.message);
  }

  handle$resolve(instruction) {
    this.cells
      .get(cellKey(instruction.address, instruction.to.cell))
      ?.cell.send({
        type: "resolve",
        request_id: instruction.request_id,
        path: instruction.path,
        content: instruction.content,
        mimetype: instruction.mimetype,
        status: instruction.status,
        encoding: instruction.encoding,
      });
  }

  handle$set_label(instruction) {
    const key = cellKey(instruction.address, instruction.to.cell);
    const entry = this.cells.get(key);
    if (!entry) return;
    entry.cell.node._cellLabel = instruction.label;
    // If this cell is the current solo cell, update the tab label live.
    const zone = this._zoneManager._zones.get(entry.zone);
    if (zone?._soloCellNode === entry.cell.node) {
      this._zoneManager._groups.get(entry.zone)?.setTabLabel(entry.zone, instruction.label);
    }
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
      const isFocused = entry.cell.node.contains(document.activeElement);
      entry.cell.close(instruction.return_code, { sticky: entry.sticky });
      this.cells.delete(key);
      if (this._activeCell === key) this._activeCell = null;
      if (!entry.sticky && isFocused) {
        this._zoneManager.focusZone(entry.zone);
      }
    }
  }

  handle$cell_configure(instruction) {
    const key = cellKey(instruction.address, instruction.to.cell);
    const entry = this.cells.get(key);
    if (!entry) return;
    if (instruction.sticky !== null) entry.sticky = instruction.sticky;
    if (instruction.label != null) {
      entry.cell.node._cellLabel = instruction.label;
      const zone = this._zoneManager._zones.get(entry.zone);
      if (zone?._soloCellNode === entry.cell.node) {
        this._zoneManager._groups.get(entry.zone)?.setTabLabel(entry.zone, instruction.label);
      }
    }
    if (instruction.background === true) {
      this._activeCell = null;
      this._zoneManager.focusZone(entry.zone);
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
    let anyStickyWasFocused = false;
    for (const [key, entry] of [...this.cells]) {
      if (addressMatchesProcess(entry.address, process_id)) {
        this._closeEchoStatus(key, instruction.return_code);
        const isFocused = entry.cell.node.contains(document.activeElement);
        if (entry.sticky && isFocused) anyStickyWasFocused = true;
        else if (!entry.sticky && isFocused) anyFocused = true;
        entry.cell.close(instruction.return_code, { sticky: entry.sticky });
        this.cells.delete(key);
        if (this._activeCell === key) this._activeCell = null;
      }
    }
    this._zoneManager.removePromptsByProcess(process_id);
    if (!anyStickyWasFocused && anyFocused) {
      focusActivePrompt();
    }
  }

  handle$prompt_create(instruction) {
    this._zoneManager.addPrompt(instruction);
  }

  handle$set_prompt(instruction) {
    this._zoneManager.setPrompt(instruction);
  }

  handle$set_input(instruction) {
    this._zoneManager.setInput(instruction);
  }

  handle$highlight(instruction) {
    this._zoneManager.applyHighlight(instruction);
  }

  handle$complete(instruction) {
    this._zoneManager.applyComplete(instruction);
  }

  handle$history_nav_result(instruction) {
    this._zoneManager.applyHistoryNav(instruction);
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
  node._bucheFocus?.();
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

function getBottomCellEntry() {
  const ordered = getOrderedCellNodes();
  if (ordered.length === 0) return null;
  const node = ordered[ordered.length - 1];
  return [..._executor.cells.values()].find((e) => e.cell.node === node) ?? null;
}

function closeActiveZone() {
  const zoneName = _executor._zoneManager._activeZoneName;

  if (zoneName === "main") {
    const zone = _executor._zoneManager._zones.get("main");
    const prompt = zone?.promptCollection._active;
    if (!prompt) return;
    _executor.bridge.sendCommand({ type: "prompt_close", to: prompt.address });
    return;
  }

  for (const [key, entry] of [..._executor.cells]) {
    if (entry.zone !== zoneName) continue;
    if (entry.cell.isAlive()) entry.cell.kill();
    entry.cell.node.remove();
    _executor.cells.delete(key);
    if (_executor._activeCell === key) _executor._activeCell = null;
    const echoEls = _executor._cellEchoElements.get(key);
    if (echoEls) { echoEls.node.remove(); _executor._cellEchoElements.delete(key); }
  }

  const zone = _executor._zoneManager._zones.get(zoneName);
  if (zone) {
    zone.buffer.replaceChildren();
    const pc = zone.promptCollection;
    for (const p of [...pc._prompts]) { p.el.remove(); p.tabEl.remove(); }
    pc._prompts = [];
    pc.onPromptsChanged?.();
  }

  _executor._zoneManager.removeZoneIfEmpty(zoneName);
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
    const entry = getFocusedCellEntry() ?? getBottomCellEntry();
    if (entry?.cell.isAlive()) entry.cell.kill();
  },

  "Control+q ~ Shift+K": (e) => {
    const entry = getFocusedCellEntry() ?? getBottomCellEntry();
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

  "$mod+p": (e) => {
    e.preventDefault();
    focusActivePrompt();
  },

  "Control+q ~ Shift+T": (e) => {
    const overlay = html`<div class="title-modal-overlay">
      <div class="title-modal">
        <label>Window title</label>
        <input type="text" value="${document.title}" />
      </div>
    </div>`;
    const input = overlay.querySelector("input");
    const close = () => overlay.remove();
    input.addEventListener("keydown", (evt) => {
      if (evt.key === "Escape") {
        evt.stopPropagation();
        close();
      } else if (evt.key === "Enter") {
        const val = input.value.trim();
        if (val) document.title = val;
        close();
      }
    });
    overlay.addEventListener("mousedown", (evt) => {
      if (evt.target === overlay) close();
    });
    document.body.appendChild(overlay);
    input.select();
  },

  "Control+q ~ Control+q": (e) => { /* cancel prefix mode */ },
  "Control+q ~ Escape": (e) => { /* cancel prefix mode */ },

  "$mod+w": (e) => {
    e.preventDefault();
    closeActiveZone();
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

  "Control+q ~ d": (e) => {
    const focused = getFocusedNavigableNode() ?? getOrderedCellNodes().at(-1) ?? null;
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
