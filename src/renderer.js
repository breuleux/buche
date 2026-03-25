import { html } from "./utils.js";
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
		this.statusDots = new Map();
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
		const echo = instruction.echo
			? this.prompt.takeEcho(instruction.cell_id)
			: null;
		const statusDot = html`<div class="cell-status cell-status-running"></div>`;
		const cellNode = html`<div class="cell" data-cell-id="${instruction.cell_id}">
			${statusDot}
			<div class="cell-header">${echo}</div>
		</div>`;
		buffer.appendChild(cellNode);
		this.statusDots.set(instruction.cell_id, statusDot);

		const handler = new HandlerClass(cellNode, instruction);
		this.cells.set(instruction.cell_id, handler);
	}

	handle$send(instruction) {
		const handler = this.cells.get(instruction.cell_id);
		if (!handler) return;
		handler.send(instruction.data);
	}

	handle$close(instruction) {
		const dot = this.statusDots.get(instruction.cell_id);
		if (dot) {
			dot.className = `cell-status ${instruction.return_code === 0 ? "cell-status-success" : "cell-status-error"}`;
			this.statusDots.delete(instruction.cell_id);
		}
		this.cells.delete(instruction.cell_id);
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
