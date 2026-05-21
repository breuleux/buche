// Runtime injected into every data: iframe.
// data: URLs get an opaque origin — scripts inside cannot touch the parent DOM,
// storage, or any other cell, but postMessage still works.
import { getIframeKeysConfig } from "../iframekeys.js";

const RUNTIME = await fetch(
  new URL("./data-runtime.html", import.meta.url),
).then((r) => r.text());

export class DataHandler {
  constructor(cellNode, _instruction, bridge) {
    this._ready = false;
    this._pending = [];
    this._bridge = bridge;

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
      const method = this[`handle$${msg.type}`];
      method.call(this, msg);
    };
    window.addEventListener("message", this._onMessage);
  }

  handle$ready(msg) {
    this._ready = true;
    const keysConfig = getIframeKeysConfig();
    if (keysConfig) {
      this._iframe.contentWindow.postMessage({ type: "buchekeysConfig", ...keysConfig }, "*");
    }
    const bufferWrap = this._iframe.closest(".zone-buffer-wrap");
    const maxHeight = bufferWrap ? bufferWrap.clientHeight : 0;
    const dynamicHeight = !this._iframe.closest(".zone-solo-cell");
    this._iframe.contentWindow.postMessage({ type: "bucheInfo", maxHeight, dynamicHeight }, "*");
    for (const m of this._pending) {
      this._iframe.contentWindow.postMessage(m, "*");
    }
    this._pending = [];
  }

  handle$resize(msg) {
    this._iframe.style.height = `${msg.height}px`;
  }

  handle$keyforward(msg) {
    const { type, ...init } = msg;
    window.dispatchEvent(new KeyboardEvent("keydown", { ...init, bubbles: false, cancelable: true }));
  }

  handle$send(msg) {
    if (this._bridge) {
      this._bridge.sendControl(msg.data);
    }
  }

  send(msg) {
    if (this._ready) {
      this._iframe.contentWindow.postMessage(msg, "*");
    } else {
      this._pending.push(msg);
    }
  }

  focus() {
    if (this._ready) {
      this._iframe.contentWindow.postMessage({ type: "focus" }, "*");
    }
  }

  setCursorState(_state) {}
}
