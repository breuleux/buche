import { html } from "./utils.js";
import { Cell } from "./cell/cell.js";
import { TextHandler } from "./cell/text.js";
import { TermHandler } from "./cell/term.js";
import { AutoHandler } from "./cell/auto.js";
import { DataHandler } from "./cell/data.js";
import { PromptCollection } from "./prompt.js";
import "./scroll-fader.js";

// ── Buffer protocol ─────────────────────────────────────────────────────

const bufferWrap = document.getElementById("buffer-wrap");
const buffer = document.createElement("div");
buffer.id = "buffer-inner";
bufferWrap.inner.appendChild(buffer);

const cellHandlers = {
  text: TextHandler,
  term: TermHandler,
  auto: AutoHandler,
  data: DataHandler,
};

class Executor {
  constructor(bridge) {
    this.cells = new Map();
    this._activeCell = null;
    this.bridge = bridge;
    this.prompt = new PromptCollection(
      document.getElementById("input-container"),
      this.bridge,
    );
    this.bridge.onInstruction((instruction) => this.execute(instruction));
    this.prompt.onAfterSubmit = (cell_id) => {
      this.prompt.disable();
      setTimeout(() => {
        this.prompt.enable();
        const cell = this.cells.get(cell_id);
        if (cell) {
          this._activeCell = cell_id;
          cell.node.focus();
        } else {
          this.prompt.focus();
        }
      }, 50);
    };
  }

  execute(instruction) {
    const handler = this[`handle$${instruction.type}`];
    if (handler) handler.call(this, instruction);
  }

  handle$new(instruction) {
    if (this.cells.has(instruction.cell_id)) {
      console.error("Cell already exists:", instruction.cell_id);
      return;
    }
    const HandlerClass = cellHandlers[instruction.mode];
    if (!HandlerClass) {
      console.error("Unknown mode:", instruction.mode);
      return;
    }
    const echo = instruction.echo
      ? this.prompt.takeEcho(instruction.cell_id)
      : null;
    const sendInput = (arg) =>
      this.bridge.sendCommand(
        typeof arg === "string"
          ? { type: "input", cell_id: instruction.cell_id, text: arg }
          : { type: "input", cell_id: instruction.cell_id, data: arg },
      );
    const cell = new Cell(instruction, echo, HandlerClass, sendInput);
    buffer.appendChild(cell.node);
    this.cells.set(instruction.cell_id, cell);
  }

  handle$send(instruction) {
    this.cells.get(instruction.cell_id)?.send(instruction);
  }

  handle$close(instruction) {
    const cell = this.cells.get(instruction.cell_id);
    if (cell) {
      const isFocused = cell.node === document.activeElement;
      cell.close(instruction.return_code);
      this.cells.delete(instruction.cell_id);
      if (this._activeCell === instruction.cell_id) {
        this._activeCell = null;
        this.prompt.enable();
        if (isFocused) this.prompt.focus();
      } else if (isFocused) {
        this.prompt.enable();
        this.prompt.focus();
      }
    }
  }

  handle$new_prompt(instruction) {
    this.prompt.addPrompt(instruction);
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

const executor = new Executor(window.buche);
