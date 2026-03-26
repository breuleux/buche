import { html } from "./utils.js";
import { Cell } from "./cell/cell.js";
import { TextHandler } from "./cell/text.js";
import { InputPrompt } from "./prompt.js";
import "./scroll-fader.js";

// ── Buffer protocol ─────────────────────────────────────────────────────

const bufferWrap = document.getElementById("buffer-wrap");
const buffer = document.createElement("div");
buffer.id = "buffer-inner";
bufferWrap.inner.appendChild(buffer);

const cellHandlers = { text: TextHandler };

class Executor {
	constructor(bridge) {
		this.cells = new Map();
		this.bridge = bridge;
		this.bridge.onInstruction((instruction) => executor.execute(instruction));
		this.prompt = new InputPrompt(
			document.getElementById("monaco-editor"),
			this.bridge,
		);
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
		const echo = instruction.echo ? this.prompt.takeEcho(instruction.cell_id) : null;
		const sendInput = (text) => this.bridge.sendCommand({ type: "input", cell_id: instruction.cell_id, text });
		const cell = new Cell(instruction, echo, HandlerClass, sendInput);
		buffer.appendChild(cell.node);
		this.cells.set(instruction.cell_id, cell);
	}

	handle$send(instruction) {
		this.cells.get(instruction.cell_id)?.send(instruction.data);
	}

	handle$close(instruction) {
		const cell = this.cells.get(instruction.cell_id);
		if (cell) {
			cell.close(instruction.return_code);
			this.cells.delete(instruction.cell_id);
		}
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
