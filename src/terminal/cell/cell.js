import { tinykeys } from "tinykeys";
import { html } from "../utils.js";

let _focusedCellNode = null;

export function clearFocusedCell() {
  _focusedCellNode?.classList.remove("cell-focused");
  _focusedCellNode = null;
}

export class Cell {
  constructor(instruction, echo, HandlerClass, bridge) {
    this._statusDot = html`<div class="cell-status cell-status-running"></div>`;
    this._btnBar = html`<span class="cell-btn-bar"></span>`;
    this._killBtn = bridge
      ? html`<button class="cell-kill-btn">✕</button>`
      : null;
    const controls = html`<span class="cell-controls">${this._btnBar}${this._killBtn}</span>`;
    this._gutterEl = html`<div class="cell-gutter">${this._statusDot}</div>`;
    // _metaEl is a permanent 0-height parking spot in the cell body.
    // In solo mode, _statusDot and _controls are moved out into the zone's
    // tab (dot left, controls right) and returned here when solo ends.
    this._metaEl = html`<div class="cell-meta">${controls}</div>`;
    const header = html`<div class="cell-header">${echo}</div>`;
    const body = html`<div class="cell-body">${this._metaEl}${header}</div>`;
    this.node = html`<div class="cell" data-cell-id="${instruction.cell_id}" tabindex="0">
			${this._gutterEl}${body}
		</div>`;
    this.node._metaEl = this._metaEl;
    this.node._statusDot = this._statusDot;
    this.node._controls = controls;
    this.node._gutterEl = this._gutterEl;
    this.node._bodyEl = body;

    this.onFocus = null; // () => void — set by Executor; called whenever this cell gains focus

    // Called when focus is programmatically restored to this cell (e.g. zone switch).
    // Each handler can implement focus() to handle internal focus delegation.
    this.node._bucheFocus = () => {
      this.onFocus?.();
      this.handler.focus?.();
    };

    this._bridge = bridge ?? null;
    this._alive = !!bridge;

    if (bridge) {
      bridge.addHeaderButton = (btn) => {
        this._btnBar.appendChild(btn);
        bridge.echoElements?.btnBar.appendChild(btn.cloneNode(true));
      };
    }

    if (this._killBtn) {
      this._killBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        bridge.killAndDelete();
      });
    }

    // Register before HandlerClass so this fires first and can suppress input.
    tinykeys(this.node, {
      "Control+z": (e) => {
        e.preventDefault();
        e.stopImmediatePropagation();
        bridge?.onBackground();
      },
      // Enter while the wrapper itself has focus (navigation mode) → enter edit mode.
      // Skip for handlers that own all input (e.g. AutoHandler) so Enter reaches the process.
      "Enter": (e) => {
        if (document.activeElement !== this.node) return;
        if (HandlerClass.handlesInput) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        this.handler.focus?.();
      },
    });

    this.handler = new HandlerClass(this.node, instruction, bridge);

    this.node.addEventListener("click", () => {
      this.node.focus();
      this.handler.focus?.();
    });
    this.node.addEventListener("focusin", () => {
      if (_focusedCellNode !== this.node) {
        _focusedCellNode?.classList.remove("cell-focused");
        _focusedCellNode = this.node;
        this.node.classList.add("cell-focused");
      }
      this.onFocus?.();
      this.handler.setCursorState?.("active");
    });
    this.node.addEventListener("focusout", (e) => {
      if (!this.node.contains(e.relatedTarget)) {
        this.handler.setCursorState?.("inactive");
      }
    });
  }

  isAlive() {
    return this._alive;
  }

  kill(signal) {
    this._bridge?.sendControl(signal ? { type: "kill", signal } : { type: "kill" });
  }

  send(data) {
    this.handler.send(data);
  }

  close(return_code, { sticky = false } = {}) {
    this._statusDot.className = `cell-status ${return_code === 0 ? "cell-status-success" : "cell-status-error"}`;
    this._alive = false;
    this.handler.setCursorState?.("hidden");
    if (!sticky) this.node.blur();
  }
}
