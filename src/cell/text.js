import { html, keyToInput } from "../utils.js";
import "../scroll-fader.js";
import { TermBuffer } from "../ansi.js";

// TODO: make configurable
const START_MAX = 100;
const REST_MAX = 1000;

export class TextHandler {
  constructor(cellNode, instruction, sendInput) {
    this.cellNode = cellNode;
    this.instruction = instruction;
    this.term = new TermBuffer();
    this._startLines = 0;
    this._restLines = 0;
    this._droppedLines = 0;
    this._buffer = []; // [{text, stream}]
    this._throttleTimer = null;
    this._currentEl = null; // current partial-line element in DOM
    this.init();
    if (sendInput) {
      cellNode.addEventListener("keydown", (e) => {
        const text = keyToInput(e);
        if (text === null) return;
        e.preventDefault();
        sendInput(text);
      });
    }
  }

  init() {
    const fader = document.createElement("scroll-fader");
    this.cellNode.appendChild(fader);

    this._startEl = html`<pre class="cell-text-inner"></pre>`;
    this._marker = html`<div class="cell-lines-dropped" hidden></div>`;
    this._restEl = html`<pre class="cell-text-inner"></pre>`;
    this._cursorEl = html`<span class="cursor cursor-inactive"></span>`;

    fader.inner.appendChild(this._restEl);
    fader.inner.appendChild(this._marker);
    fader.inner.appendChild(this._startEl);
  }

  setCursorState(state) {
    this._cursorEl.className = `cursor cursor-${state}`;
  }

  send(data) {
    this._buffer.push({ text: data.text, stream: data.stream || "stdout" });
    if (this._startLines < START_MAX || this._restLines < REST_MAX) {
      this._flush();
    } else if (!this._throttleTimer) {
      this._throttleTimer = setTimeout(() => this._flush(), 100);
    }
  }

  _addLine(lineNode) {
    if (this._startLines < START_MAX) {
      this._startEl.appendChild(lineNode);
      this._startLines++;
    } else {
      // Prune oldest rest lines to stay within REST_MAX
      while (this._restLines >= REST_MAX && this._restEl.firstChild) {
        // Don't remove the current partial-line element
        if (this._restEl.firstChild === this._currentEl) break;
        this._restEl.removeChild(this._restEl.firstChild);
        this._droppedLines++;
        this._restLines--;
      }
      this._restEl.appendChild(lineNode);
      this._restLines++;
    }
  }

  _flush() {
    this._throttleTimer = null;

    // Remove current partial-line element and cursor so we can reattach them.
    this._cursorEl.remove();
    if (this._currentEl) {
      this._currentEl.remove();
      this._currentEl = null;
    }

    // Drop excess lines from the front before feeding into TermBuffer.
    const capacity = (START_MAX - this._startLines) + REST_MAX;
    let bufNewlines = 0;
    for (const { text } of this._buffer) {
      for (let i = 0; i < text.length; i++) if (text[i] === "\n") bufNewlines++;
    }
    if (bufNewlines > capacity) {
      let toDrop = bufNewlines - capacity;
      this._droppedLines += toDrop;
      while (toDrop > 0) {
        const entry = this._buffer[0];
        let count = 0;
        for (let i = 0; i < entry.text.length; i++) if (entry.text[i] === "\n") count++;
        if (count <= toDrop) {
          toDrop -= count;
          this._buffer.shift();
        } else {
          let idx = -1;
          for (let i = 0; i < toDrop; i++) idx = entry.text.indexOf("\n", idx + 1);
          this._buffer[0] = { text: entry.text.slice(idx + 1), stream: entry.stream };
          toDrop = 0;
        }
      }
      this.term.resetStyle();
    }

    for (const { text, stream } of this._buffer) {
      for (const lineNode of this.term.write(text, stream)) {
        this._addLine(lineNode);
      }
    }
    this._buffer = [];

    // Re-append the current partial line and cursor at the end.
    const activeEl = this._startLines < START_MAX ? this._startEl : this._restEl;
    this._currentEl = this.term.currentLineNode();
    if (this._currentEl) activeEl.appendChild(this._currentEl);
    activeEl.appendChild(this._cursorEl);

    if (this._droppedLines > 0) {
      this._marker.innerHTML = `<div>${this._droppedLines} lines dropped</div>`;
      this._marker.removeAttribute("hidden");
    }
  }
}
