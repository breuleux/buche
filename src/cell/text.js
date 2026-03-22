import { html } from '../utils.js';

export class TextHandler {
  constructor(cellNode, instruction) {
    this.cellNode    = cellNode;
    this.instruction = instruction;
    this.wrapper     = null; // .cell-text  — overlay host
    this.scrollEl    = null; // .cell-text-scroll — scroll container
    this.pre         = null; // .cell-text-inner  — content
  }

  init(makeShadows, updateScrollFades) {
    if (this.instruction.data) {
      this.cellNode.appendChild(html`<pre class="cell-input">${this.instruction.data.text}</pre>`);
    }

    this.wrapper  = html`<div class="cell-text"><div class="cell-text-scroll"><pre class="cell-text-inner"></pre></div></div>`;
    this.scrollEl = this.wrapper.querySelector('.cell-text-scroll');
    this.pre      = this.wrapper.querySelector('.cell-text-inner');
    this.cellNode.appendChild(this.wrapper);

    this.shadows = makeShadows(this.wrapper, 32);
    this._updateFades = updateScrollFades;
    this.scrollEl.addEventListener('scroll',
      () => updateScrollFades(this.scrollEl, this.shadows));
    updateScrollFades(this.scrollEl, this.shadows);
  }

  send(data) {
    this.pre.appendChild(html`<span class="text-${data.stream || 'stdout'}">${data.text}</span>`);
    this._updateFades(this.scrollEl, this.shadows);
  }
}
