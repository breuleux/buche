import { html } from "../utils.js";

export class DataHandler {
  constructor(cellNode, _instruction, _sendInput) {
    this._container = html`<div class="cell-data"></div>`;
    cellNode.appendChild(this._container);
  }

  send(data) {
    if (data.stream !== "dataout") return;
    const { type, content, mode = "append", selector } = data.data;
    if (type !== "html") return;

    if (selector) {
      for (const target of this._container.querySelectorAll(selector)) {
        this._apply(target, mode, content);
      }
    } else {
      this._apply(this._container, mode, content);
    }
  }

  _apply(target, mode, content) {
    if (mode === "set") {
      target.innerHTML = content;
    } else if (mode === "replace") {
      const t = document.createElement("template");
      t.innerHTML = content;
      target.replaceWith(...t.content.childNodes);
    } else {
      target.insertAdjacentHTML("beforeend", content);
    }
  }

  setCursorState(_state) {}
}
