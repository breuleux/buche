import { tinykeys } from "tinykeys";
import { html } from "../utils.js";

export class Cell {
  constructor(instruction, echo, HandlerClass, bridge) {
    this._statusDot = html`<div class="cell-status cell-status-running"></div>`;
    this._btnBar = html`<span class="cell-btn-bar"></span>`;
    this._killBtn = bridge
      ? html`<button class="cell-kill-btn">✕</button>`
      : null;
    const controls = html`<span class="cell-controls">${this._btnBar}${this._killBtn}</span>`;
    const header = html`<div class="cell-header">${echo}${controls}</div>`;
    this.node = html`<div class="cell" data-cell-id="${instruction.cell_id}" tabindex="0">
			${this._statusDot}
			${header}
		</div>`;

    this._bridge = bridge ?? null;

    if (bridge) {
      bridge.addHeaderButton = (btn) => this._btnBar.appendChild(btn);
    }

    if (this._killBtn) {
      this._killBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        bridge.sendControl({ type: "kill" });
      });
    }

    header.addEventListener("mouseenter", () => {
      this.node.style.height = `${this.node.offsetHeight}px`;
    });
    header.addEventListener("mouseleave", () => {
      const node = this.node;
      if (!node.style.height) return;
      const locked = node.offsetHeight;
      node.style.height = "";
      const natural = node.offsetHeight;
      if (locked === natural) return;
      node.style.height = `${locked}px`;
      node.offsetHeight; // force reflow
      node.style.height = `${natural}px`;
      node.addEventListener("transitionend", () => { node.style.height = ""; }, { once: true });
    });

    // Register before HandlerClass so this fires first and can suppress input.
    tinykeys(this.node, {
      "Control+z": (e) => {
        e.preventDefault();
        e.stopImmediatePropagation();
        bridge?.onBackground();
      },
      // Enter while the wrapper itself has focus (navigation mode) → enter edit mode.
      "Enter": (e) => {
        if (document.activeElement !== this.node) return;
        if (!this.isAlive()) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        this.handler.focus?.();
      },
    });

    this.handler = new HandlerClass(this.node, instruction, bridge);

    this.node.addEventListener("click", () => {
      this.node.focus();
      if (this.isAlive()) this.handler.focus?.();
    });
    this.node.addEventListener("focusin", () =>
      this.handler.setCursorState?.("active"),
    );
    this.node.addEventListener("focusout", (e) => {
      if (!this.node.contains(e.relatedTarget)) {
        this.handler.setCursorState?.("inactive");
      }
    });
  }

  isAlive() {
    return this._killBtn !== null;
  }

  kill(signal) {
    this._bridge?.sendControl(signal ? { type: "kill", signal } : { type: "kill" });
  }

  send(data) {
    this.handler.send(data);
  }

  close(return_code) {
    this._statusDot.className = `cell-status ${return_code === 0 ? "cell-status-success" : "cell-status-error"}`;
    if (this._killBtn) {
      this._killBtn.style.visibility = "hidden";
      this._killBtn.style.pointerEvents = "none";
      this._killBtn = null;
    }
    this.handler.setCursorState?.("hidden");
    this.node.blur();
  }
}
