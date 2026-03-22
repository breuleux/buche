import { html } from '../utils.js';
import '../scroll-fader.js';

export class TextHandler {
  constructor(cellNode, instruction) {
    this.cellNode    = cellNode;
    this.instruction = instruction;
    this.pre         = null;
  }

  init() {
    if (this.instruction.data) {
      this.cellNode.appendChild(html`<pre class="cell-input">${this.instruction.data.text}</pre>`);
    }

    const fader = document.createElement('scroll-fader');
    this.cellNode.appendChild(fader);

    this.pre = html`<pre class="cell-text-inner"></pre>`;
    fader.inner.appendChild(this.pre);
  }

  send(data) {
    this.pre.appendChild(html`<span class="text-${data.stream || 'stdout'}">${data.text}</span>`);
  }
}
