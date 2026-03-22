import { html } from './utils.js';
import { TextHandler } from './cell/text.js';
import { InputPrompt } from './prompt.js';
import './scroll-fader.js';

const prompt = new InputPrompt('monaco-editor', window.buche);

// ── Buffer protocol ─────────────────────────────────────────────────────

const bufferWrap = document.getElementById('buffer-wrap');
const buffer     = document.createElement('div');
buffer.id = 'buffer-inner';
bufferWrap.inner.appendChild(buffer);

const cellHandlers = { text: TextHandler };

class Executor {
  constructor() {
    this.cells = new Map();
  }

  execute(instruction) {
    const handler = this[`handle$${instruction.type}`];
    if (handler) handler.call(this, instruction);
  }

  handle$new(instruction) {
    if (this.cells.has(instruction.cell_id)) {
      console.error('Cell already exists:', instruction.cell_id);
      return;
    }
    const HandlerClass = cellHandlers[instruction.mode];
    if (!HandlerClass) {
      console.error('Unknown mode:', instruction.mode);
      return;
    }
    const cellNode = html`<div class="cell" data-cell-id="${instruction.cell_id}"></div>`;
    buffer.appendChild(cellNode);

    const handler = new HandlerClass(cellNode, instruction);
    this.cells.set(instruction.cell_id, handler);
  }

  handle$send(instruction) {
    const handler = this.cells.get(instruction.cell_id);
    if (!handler) return;
    handler.send(instruction.data);
  }

  handle$close(instruction) {
    this.cells.delete(instruction.cell_id);
  }

  handle$error(instruction) {
    const traceback = (instruction.traceback || []).map(line => html`<div class="error-traceback-line">${line}</div>`);
    const cell = html`
      <div class="cell cell-error">
        <pre class="error-header">${instruction.error_type}: ${instruction.message}</pre>
        ${traceback.length ? html`<div class="error-traceback">${traceback}</div>` : null}
      </div>`;
    buffer.appendChild(cell);
  }
}

const executor = new Executor();
window.buche.onInstruction(instruction => executor.execute(instruction));
