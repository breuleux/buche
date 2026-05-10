import { AutoHandler } from "./cell/auto.js";
import { Cell } from "./cell/cell.js";
import { DataHandler } from "./cell/data.js";
import { TermHandler } from "./cell/term.js";
import { TextHandler } from "./cell/text.js";
import { PromptCollection } from "./prompt.js";
import { html } from "./utils.js";
import "./scroll-fader.js";

// ── Buffer protocol ─────────────────────────────────────────────────────

const bufferWrap = document.getElementById("buffer-wrap");
const buffer = document.createElement("div");
buffer.id = "buffer-inner";
bufferWrap.inner.appendChild(buffer);

// ── Terminal width tracking ──────────────────────────────────────────────
// Measure char width once using canvas (same font as the UI), then derive
// cols from the buffer container width on every resize.
{
  const ctx = document.createElement("canvas").getContext("2d");
  ctx.font = "13px Consolas, Menlo, monospace";
  const charWidth = ctx.measureText("M").width;
  const CELL_PADDING = 16; // .cell padding-left in styles.css

  const sendResize = () => {
    const width = bufferWrap.clientWidth;
    if (width > 0) {
      const cols = Math.max(1, Math.floor((width - CELL_PADDING) / charWidth));
      window.buche.sendCommand({ type: "resize", cols });
    }
  };
  new ResizeObserver(sendResize).observe(bufferWrap);
  sendResize();
}

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
  sendControl(arg) {
    console.log({ ...arg, to: this.instruction.address });
    this.executor.bridge.sendCommand({ ...arg, to: this.instruction.address });
  }
  onBackground() {
    this.executor._activeCell = null;
    this.executor.prompt.focus();
  }
}

class Executor {
  constructor(bridge) {
    // Map<key, {cell: Cell, address: object}>
    this.cells = new Map();
    this._activeCell = null;
    this.bridge = bridge;
    this.prompt = new PromptCollection(
      document.getElementById("input-container"),
      this.bridge,
    );
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
    buffer.appendChild(cell.node);
    this.cells.set(key, { cell, address: instruction.address });
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
          this.prompt.focus();
        }
      } else if (isFocused) {
        this.prompt.focus();
      }
    }
  }

  handle$process_close(instruction) {
    const { process_id } = instruction;
    let anyFocused = false;
    for (const [key, entry] of [...this.cells]) {
      if (entry.address?.process === process_id) {
        if (entry.cell.node === document.activeElement) anyFocused = true;
        entry.cell.close(instruction.return_code);
        this.cells.delete(key);
        if (this._activeCell === key) this._activeCell = null;
      }
    }
    this.prompt.removePromptsByProcess(process_id);
    if (anyFocused || this._activeCell === null) {
      this.prompt.focus();
    }
  }

  handle$prompt_create(instruction) {
    this.prompt.addPrompt(instruction);
    this.prompt.focus();
  }

  handle$set_prompt(instruction) {
    this.prompt.setPrompt(instruction);
  }

  handle$highlight(instruction) {
    this.prompt.applyHighlight(instruction);
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
    buffer.appendChild(cell);
  }
}

const _executor = new Executor(window.buche);
