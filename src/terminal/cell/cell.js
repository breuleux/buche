import { tinykeys } from "tinykeys";
import { html } from "../utils.js";

export class Cell {
  constructor(instruction, echo, HandlerClass, bridge) {
    this._statusDot = html`<div class="cell-status cell-status-running"></div>`;
    this._killBtn = bridge
      ? html`<button class="cell-kill-btn">✕</button>`
      : null;
    const header = html`<div class="cell-header">${echo}${this._killBtn}</div>`;
    this.node = html`<div class="cell" data-cell-id="${instruction.cell_id}" tabindex="0">
			${this._statusDot}
			${header}
		</div>`;

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
      this.node.style.height = "";
    });

    // Register before HandlerClass so this fires first and can suppress input.
    tinykeys(this.node, {
      "Control+z": (e) => {
        e.preventDefault();
        e.stopImmediatePropagation();
        bridge?.onBackground();
      },
    });

    this.handler = new HandlerClass(this.node, instruction, bridge);

    this.node.addEventListener("click", () => {
      this.node.focus();
      this.handler.focus?.();
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

  send(data) {
    this.handler.send(data);
  }

  close(return_code) {
    this._statusDot.className = `cell-status ${return_code === 0 ? "cell-status-success" : "cell-status-error"}`;
    this._killBtn?.remove();
    this._killBtn = null;
    this.handler.setCursorState?.("hidden");
    this.node.removeAttribute("tabindex");
    this.node.blur();
  }
}
