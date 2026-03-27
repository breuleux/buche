import { keyToInput } from "../utils.js";
import { TextHandler } from "./text.js";
import { TermHandler } from "./term.js";
import { DataHandler } from "./data.js";

// Sequences that indicate a full-screen TUI has taken over the terminal.
const FULLSCREEN_RE = /\x1b\[(?:\?1049h|2J)/;

const BUFFER_MAX_LINES = 1000;

export class AutoHandler {
  static handlesInput = true;

  constructor(cellNode, instruction, sendInput) {
    this.instruction = instruction;
    this._sendInput = sendInput;
    this._wrapper = document.createElement("div");
    cellNode.appendChild(this._wrapper);
    this._handler = new TextHandler(this._wrapper, instruction);
    this._buffer = [];
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

    if (data.stream === "dataout") {
      this._switchTo(DataHandler);
    } else if (data.text && FULLSCREEN_RE.test(data.text)) {
      this._switchTo(TermHandler);
    } else {
      this._handler.send(data);
    }
  }

  _addToBuffer(data) {
    this._buffer.push(data);
    const text = data.text ?? "";
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "\n") this._bufferLines++;
    }

    while (this._bufferLines > BUFFER_MAX_LINES && this._buffer.length > 0) {
      const first = this._buffer[0];
      const firstText = first.text ?? "";
      let lines = 0;
      for (let i = 0; i < firstText.length; i++) {
        if (firstText[i] === "\n") lines++;
      }

      if (this._bufferLines - lines >= BUFFER_MAX_LINES) {
        this._buffer.shift();
        this._bufferLines -= lines;
      } else {
        const toRemove = this._bufferLines - BUFFER_MAX_LINES;
        let idx = -1;
        for (let i = 0; i < toRemove; i++)
          idx = firstText.indexOf("\n", idx + 1);
        this._buffer[0] = {
          text: firstText.slice(idx + 1),
          stream: first.stream,
        };
        this._bufferLines -= toRemove;
        break;
      }
    }
  }

  _switchTo(HandlerClass) {
    this._switched = true;
    while (this._wrapper.firstChild)
      this._wrapper.removeChild(this._wrapper.firstChild);
    this._handler = new HandlerClass(
      this._wrapper,
      this.instruction,
      this._sendInput,
    );
    for (const data of this._buffer) this._handler.send(data);
    this._buffer = [];
  }

  setCursorState(state) {
    this._handler.setCursorState(state);
  }
}
