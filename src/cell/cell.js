import { html } from "../utils.js";

export class Cell {
	constructor(instruction, echo, HandlerClass) {
		this._statusDot = html`<div class="cell-status cell-status-running"></div>`;
		this.node = html`<div class="cell" data-cell-id="${instruction.cell_id}">
			${this._statusDot}
			<div class="cell-header">${echo}</div>
		</div>`;
		this.handler = new HandlerClass(this.node, instruction);
	}

	send(data) {
		this.handler.send(data);
	}

	close(return_code) {
		this._statusDot.className = `cell-status ${return_code === 0 ? "cell-status-success" : "cell-status-error"}`;
	}
}
