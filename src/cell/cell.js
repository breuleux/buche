import { html } from "../utils.js";

function keyToInput(e) {
  if (e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1) {
    const code = e.key.toUpperCase().charCodeAt(0) - 64;
    if (code > 0 && code < 32) return String.fromCharCode(code);
  }
  if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) return e.key;
  switch (e.key) {
    case "Enter":
      return "\n";
    case "Backspace":
      return "\x7f";
    case "Tab":
      return "\t";
    case "Escape":
      return "\x1b";
    case "ArrowUp":
      return "\x1b[A";
    case "ArrowDown":
      return "\x1b[B";
    case "ArrowRight":
      return "\x1b[C";
    case "ArrowLeft":
      return "\x1b[D";
    case "Delete":
      return "\x1b[3~";
    case "Home":
      return "\x1b[H";
    case "End":
      return "\x1b[F";
    case "PageUp":
      return "\x1b[5~";
    case "PageDown":
      return "\x1b[6~";
  }
  return null;
}

export class Cell {
  constructor(instruction, echo, HandlerClass, sendInput) {
    this._statusDot = html`<div class="cell-status cell-status-running"></div>`;
    this.node = html`<div class="cell" data-cell-id="${instruction.cell_id}" tabindex="0">
			${this._statusDot}
			<div class="cell-header">${echo}</div>
		</div>`;
    this.handler = new HandlerClass(this.node, instruction);

    this.node.addEventListener("click", () => this.node.focus());
    this.node.addEventListener("keydown", (e) => {
      const text = keyToInput(e);
      if (text === null) return;
      e.preventDefault();
      sendInput(text);
    });
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
