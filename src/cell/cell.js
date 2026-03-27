import { html } from "../utils.js";

export class Cell {
  constructor(instruction, echo, HandlerClass, sendInput) {
    this._statusDot = html`<div class="cell-status cell-status-running"></div>`;
    this.node = html`<div class="cell" data-cell-id="${instruction.cell_id}" tabindex="0">
			${this._statusDot}
			<div class="cell-header">${echo}</div>
		</div>`;
    this.handler = new HandlerClass(this.node, instruction, sendInput);

    this.node.addEventListener("click", () => this.node.focus());
    this.node.addEventListener("focus", () => this.handler.setCursorState?.("active"));
    this.node.addEventListener("blur", () => this.handler.setCursorState?.("inactive"));
  }

  send(data) {
    this.handler.send(data);
  }

  close(return_code) {
    this._statusDot.className = `cell-status ${return_code === 0 ? "cell-status-success" : "cell-status-error"}`;
    this.handler.setCursorState?.("hidden");
    this.node.removeAttribute("tabindex");
    this.node.blur();
  }
}
