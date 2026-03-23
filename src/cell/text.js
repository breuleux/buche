import { html } from "../utils.js";
import "../scroll-fader.js";
import { AnsiParser } from "../ansi.js";

export class TextHandler {
	constructor(cellNode, instruction) {
		this.cellNode = cellNode;
		this.instruction = instruction;
		this.pre = null;
		this.ansi = new AnsiParser();
		this.init();
	}

	init() {
		if (this.instruction.data) {
			this.cellNode.appendChild(
				html`<pre class="cell-input">${this.instruction.data.text}</pre>`,
			);
		}

		const fader = document.createElement("scroll-fader");
		this.cellNode.appendChild(fader);

		this.pre = html`<pre class="cell-text-inner"></pre>`;
		fader.inner.appendChild(this.pre);
	}

	send(data) {
		for (const node of this.ansi.parse(data.text, data.stream || "stdout"))
			this.pre.appendChild(node);
	}
}
