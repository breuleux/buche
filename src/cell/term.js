import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { html, keyToInput } from "../utils.js";

export class TermHandler {
  constructor(cellNode, _instruction, sendInput) {
    this._term = new Terminal({ scrollback: 1000, convertEol: false, fontFamily: '"Consolas", "Menlo", monospace', fontSize: 13 });
    this._fitAddon = new FitAddon();
    this._term.loadAddon(this._fitAddon);

    const container = html`<div class="cell-term"></div>`;
    cellNode.appendChild(container);

    this._term.open(container);
    this._fitAddon.fit();

    this._resizeObserver = new ResizeObserver(() => this._fitAddon.fit());
    this._resizeObserver.observe(container);

    if (sendInput) {
      cellNode.addEventListener("keydown", (e) => {
        const text = keyToInput(e);
        if (text === null) {
          return;
        }
        e.preventDefault();
        sendInput(text);
      });
    }
  }

  send(data) {
    this._term.write(data.text);
  }

  setCursorState(_state) {
    // xterm.js manages its own cursor
  }
}
