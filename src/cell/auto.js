import { keyToInput } from "../utils.js";
import { TextHandler } from "./text.js";
import { TermHandler } from "./term.js";

// Sequences that indicate a full-screen TUI has taken over the terminal.
const FULLSCREEN_RE = /\x1b\[(?:\?1049h|2J)/;

const BUFFER_MAX_LINES = 1000;

export class AutoHandler {
  constructor(cellNode, instruction, sendInput) {
    this.instruction = instruction;
    this._wrapper = document.createElement("div");
    cellNode.appendChild(this._wrapper);
    this._handler = new TextHandler(this._wrapper, instruction);
    this._buffer = []; // [{text, stream}]
    this._bufferLines = 0;
    this._switched = false;
    if (sendInput) {
      cellNode.addEventListener("keydown", (e) => {
        const text = keyToInput(e);
        if (text === null) return;
        e.preventDefault();
        sendInput(text);
      });
    }
  }

  send(data) {
    if (this._switched) {
      this._handler.send(data);
      return;
    }

    this._addToBuffer(data);

    if (FULLSCREEN_RE.test(data.text)) {
      this._switchToTerm();
    } else {
      this._handler.send(data);
    }
  }

  _addToBuffer(data) {
    this._buffer.push(data);
    for (let i = 0; i < data.text.length; i++) {
      if (data.text[i] === "\n") this._bufferLines++;
    }

    while (this._bufferLines > BUFFER_MAX_LINES && this._buffer.length > 0) {
      const first = this._buffer[0];
      let lines = 0;
      for (let i = 0; i < first.text.length; i++) {
        if (first.text[i] === "\n") lines++;
      }

      if (this._bufferLines - lines >= BUFFER_MAX_LINES) {
        this._buffer.shift();
        this._bufferLines -= lines;
      } else {
        const toRemove = this._bufferLines - BUFFER_MAX_LINES;
        let idx = -1;
        for (let i = 0; i < toRemove; i++) idx = first.text.indexOf("\n", idx + 1);
        this._buffer[0] = { text: first.text.slice(idx + 1), stream: first.stream };
        this._bufferLines -= toRemove;
        break;
      }
    }
  }

  _switchToTerm() {
    this._switched = true;
    while (this._wrapper.firstChild) this._wrapper.removeChild(this._wrapper.firstChild);
    this._handler = new TermHandler(this._wrapper, this.instruction);
    for (const data of this._buffer) this._handler.send(data);
    this._buffer = [];
  }

  setCursorState(state) {
    this._handler.setCursorState(state);
  }
}
