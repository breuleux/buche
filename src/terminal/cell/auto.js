import { DataHandler } from "./data.js";
import { TermHandler } from "./term.js";
import { TextHandler } from "./text.js";
import { TermBuffer } from "../ansi.js";
import { html } from "../utils.js";

const BUFFER_MAX_LINES = 1000;

export class AutoHandler {
  static handlesInput = true;

  constructor(cellNode, instruction, bridge) {
    this.instruction = instruction;
    this._bridge = bridge;

    this._stdioWrapper = document.createElement("div");
    this._dataWrapper = document.createElement("div");
    this._dataWrapper.style.display = "none";

    const mainWrapper = document.createElement("div");
    mainWrapper.appendChild(this._stdioWrapper);
    mainWrapper.appendChild(this._dataWrapper);
    cellNode.appendChild(mainWrapper);

    this._stdioHandler = new TextHandler(this._stdioWrapper, instruction);
    this._dataHandler = null;

    // Buffer for stdio messages; cleared once we switch Text→Term
    this._buffer = [];
    this._bufferLines = 0;
    this._switched = false;

    // Buttons added to header when DataHandler is first created
    this._stdioBtn = null;
    this._guiBtn = null;
  }

  _triggerActivity(btn) {
    if (!btn) return;
    btn.classList.remove("cell-view-btn-activity");
    void btn.offsetWidth; // force reflow to restart animation
    btn.classList.add("cell-view-btn-activity");
  }

  send(data) {
    if (data.type !== "text") {
      this._ensureDataHandler();
      this._dataHandler.send(data);
      if (this._stdioWrapper.style.display !== "none") {
        this._triggerActivity(this._guiBtn);
      }
    } else if (!this._switched) {
      this._addToBuffer(data);
      if (data.text && TermBuffer.containsUnhandledEscape(data.text)) {
        this._switchToTerm();
      } else {
        this._stdioHandler.send(data);
      }
      if (this._stdioWrapper.style.display === "none") {
        this._triggerActivity(this._stdioBtn);
      }
    } else {
      this._stdioHandler.send(data);
      if (this._stdioWrapper.style.display === "none") {
        this._triggerActivity(this._stdioBtn);
      }
    }
  }

  _ensureDataHandler() {
    if (this._dataHandler) return;

    this._dataHandler = new DataHandler(
      this._dataWrapper,
      this.instruction,
      this._bridge,
    );

    if (this._bridge?.addHeaderButton) {
      this._stdioBtn = html`<button class="cell-view-btn" title="stdio output">⌨</button>`;
      this._guiBtn = html`<button class="cell-view-btn cell-view-btn-active" title="GUI output">⊞</button>`;
      this._stdioBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this._showStdio();
      });
      this._guiBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this._showGui();
      });
      this._bridge.addHeaderButton(this._stdioBtn);
      this._bridge.addHeaderButton(this._guiBtn);
    }

    this._showGui();
  }

  _showGui() {
    this._stdioWrapper.style.display = "none";
    this._dataWrapper.style.display = "";
    this._stdioBtn?.classList.remove("cell-view-btn-active");
    this._guiBtn?.classList.add("cell-view-btn-active");
    this._guiBtn?.classList.remove("cell-view-btn-activity");
  }

  _showStdio() {
    this._dataWrapper.style.display = "none";
    this._stdioWrapper.style.display = "";
    this._stdioBtn?.classList.add("cell-view-btn-active");
    this._guiBtn?.classList.remove("cell-view-btn-active");
    this._stdioBtn?.classList.remove("cell-view-btn-activity");
    this._stdioHandler.focus?.();
  }

  _addToBuffer(data) {
    this._buffer.push(data);
    const text = data.text ?? "";
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "\n") {
        this._bufferLines++;
      }
    }

    while (this._bufferLines > BUFFER_MAX_LINES && this._buffer.length > 0) {
      const first = this._buffer[0];
      const firstText = first.text ?? "";
      let lines = 0;
      for (let i = 0; i < firstText.length; i++) {
        if (firstText[i] === "\n") {
          lines++;
        }
      }

      if (this._bufferLines - lines >= BUFFER_MAX_LINES) {
        this._buffer.shift();
        this._bufferLines -= lines;
      } else {
        const toRemove = this._bufferLines - BUFFER_MAX_LINES;
        let idx = -1;
        for (let i = 0; i < toRemove; i++) {
          idx = firstText.indexOf("\n", idx + 1);
        }
        this._buffer[0] = {
          text: firstText.slice(idx + 1),
          stream: first.stream,
        };
        this._bufferLines -= toRemove;
        break;
      }
    }
  }

  _switchToTerm() {
    this._switched = true;
    while (this._stdioWrapper.firstChild) {
      this._stdioWrapper.removeChild(this._stdioWrapper.firstChild);
    }
    this._stdioHandler = new TermHandler(
      this._stdioWrapper,
      this.instruction,
      this._bridge,
    );
    for (const data of this._buffer) {
      this._stdioHandler.send(data);
    }
    this._buffer = [];
    if (this._stdioWrapper.style.display !== "none") {
      this._stdioHandler.focus?.();
    }
  }

  focus() {
    if (this._dataWrapper.style.display !== "none") {
      this._dataHandler?.focus?.();
    } else {
      this._stdioHandler?.focus?.();
    }
  }

  setCursorState(state) {
    this._stdioHandler?.setCursorState?.(state);
  }
}
