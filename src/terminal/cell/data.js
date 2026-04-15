// Runtime injected into every data: iframe.
// data: URLs get an opaque origin — scripts inside cannot touch the parent DOM,
// storage, or any other cell, but postMessage still works.
const RUNTIME = await fetch(
  new URL("./data-runtime.html", import.meta.url),
).then((r) => r.text());

export class DataHandler {
  constructor(cellNode, _instruction, sendInput) {
    this._ready = false;
    this._pending = [];

    this._iframe = document.createElement("iframe");
    this._iframe.style.cssText =
      "border:none;width:100%;display:block;height:0;max-height:600px;";
    this._iframe.src = `data:text/html;charset=utf-8,${encodeURIComponent(RUNTIME)}`;
    cellNode.appendChild(this._iframe);

    this._onMessage = (e) => {
      if (
        !this._iframe.contentWindow ||
        e.source !== this._iframe.contentWindow
      ) {
        return;
      }
      const msg = e.data;
      if (!msg) {
        return;
      }
      if (msg._buche === "ready") {
        this._ready = true;
        for (const m of this._pending) {
          this._iframe.contentWindow.postMessage(m, "*");
        }
        this._pending = [];
      } else if (msg._buche === "resize") {
        this._iframe.style.height = `${msg.height}px`;
      } else if (msg._buche === "send" && sendInput) {
        sendInput(msg.data);
      }
    };
    window.addEventListener("message", this._onMessage);
  }

  send(data) {
    if (data.stream !== "dataout") {
      return;
    }
    const { type, content, mode, selector } = data.data;
    if (type !== "html") {
      return;
    }
    this._post({ _buche: "op", content, mode, selector });
  }

  _post(msg) {
    if (this._ready) {
      this._iframe.contentWindow.postMessage(msg, "*");
    } else {
      this._pending.push(msg);
    }
  }

  setCursorState(_state) {}
}
