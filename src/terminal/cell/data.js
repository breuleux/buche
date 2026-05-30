import { getIframeKeysConfig } from "../iframekeys.js";

let _procCellCounter = 0;

export class DataHandler {
  constructor(cellNode, _instruction, bridge) {
    this._ready = false;
    this._pending = [];
    this._bridge = bridge;
    this._procCellId = `c${++_procCellCounter}`;

    this._iframe = document.createElement("iframe");
    this._iframe.setAttribute("sandbox", "allow-scripts");
    this._iframe.style.cssText =
      "border:none;width:100%;display:block;height:0;max-height:600px;";
    this._iframe.src = `proc://${this._procCellId}/`;
    (cellNode._bodyEl ?? cellNode).appendChild(this._iframe);

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

    // Receive proc:// resource requests relayed from preload via window.postMessage.
    this._onProcRequest = (e) => {
      if (e.source !== window || e.data?.__buche !== "proc:request") return;
      if (e.data.cellId !== this._procCellId) return;
      this._iframe.contentWindow?.postMessage(
        { type: "resolve", request_id: e.data.requestId, path: e.data.path, method: e.data.method },
        "*",
      );
    };
    window.addEventListener("message", this._onProcRequest);
  }

  handle$ready(msg) {
    this._ready = true;
    const keysConfig = getIframeKeysConfig();
    if (keysConfig) {
      this._iframe.contentWindow.postMessage({ type: "buchekeysConfig", ...keysConfig }, "*");
    }
    const computedMax = getComputedStyle(this._iframe).maxHeight;
    const maxHeight = computedMax === "none" ? 0 : parseInt(computedMax);
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

  handle$blur(_msg) {
    this._bridge?.onBackground();
  }

  handle$focus(_msg) {
    this._bridge?.onFocus?.();
  }

  handle$resolve(msg) {
    if (msg.request_id != null) {
      // Response to an on-demand proc:// request relayed from main
      window.buche.proc.respond(
        msg.request_id,
        msg.status ?? 200,
        msg.content ?? "",
        msg.mimetype ?? "application/octet-stream",
        msg.encoding,
      );
    }
  }

  handle$send(msg) {
    if (this._bridge) {
      this._bridge.sendControl(msg.data);
    }
  }

  send(msg) {
    if (msg.type === "resolve") {
      window.buche.proc.cache(
        this._procCellId,
        msg.path,
        msg.content ?? "",
        msg.mimetype ?? "application/octet-stream",
        msg.encoding ?? null,
      );
      return;
    }
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
