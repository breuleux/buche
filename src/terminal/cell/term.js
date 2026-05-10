import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { html } from "../utils.js";

export class TermHandler {
  constructor(cellNode, _instruction, bridge) {
    this._term = new Terminal({
      scrollback: 1000,
      convertEol: false,
      fontFamily: '"Consolas", "Menlo", monospace',
      fontSize: 13,
    });
    this._fitAddon = new FitAddon();
    this._term.loadAddon(this._fitAddon);

    const container = html`<div class="cell-term"></div>`;
    cellNode.appendChild(container);

    if (bridge) {
      // Use xterm's onData so it handles application cursor mode, sends \r for
      // Enter, and generally translates keys correctly for terminal programs.
      this._term.onData((text) => bridge.sendInput(text));
      // Keep the PTY dimensions in sync with the xterm viewport.
      this._term.onResize(({ cols, rows }) => bridge.sendResize(cols, rows));
      // Forward focus from the cell div to xterm's internal textarea.
      // Works when TermHandler is used directly (cellNode is the real cell div).
      // When used via AutoHandler, AutoHandler calls this.focus() instead.
      cellNode.addEventListener("focus", () => this._term.focus());
    }

    this._term.open(container);
    this._fitAddon.fit();

    this._resizeObserver = new ResizeObserver(() => this._fitAddon.fit());
    this._resizeObserver.observe(container);
  }

  send(data) {
    this._term.write(data.text);
  }

  focus() {
    this._term.focus();
  }

  setCursorState(_state) {
    // xterm.js manages its own cursor
  }
}
