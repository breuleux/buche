import { html } from "../utils.js";
import "../scroll-fader.js";
import { AnsiParser } from "../ansi.js";

// TODO: make configurable
const START_MAX = 100;
const REST_MAX = 1000;

function countNewlines(str) {
	return (str.match(/\n/g) || []).length;
}

// Split text after the nth newline: [before+newline, after]
function splitAtLine(text, n) {
	let idx = -1;
	for (let i = 0; i < n; i++) {
		idx = text.indexOf("\n", idx + 1);
		if (idx === -1) return [text, ""];
	}
	return [text.slice(0, idx + 1), text.slice(idx + 1)];
}

export class TextHandler {
	constructor(cellNode, instruction) {
		this.cellNode = cellNode;
		this.instruction = instruction;
		this.ansi = new AnsiParser();
		this._startLines = 0;
		this._restLines = 0;
		this._droppedLines = 0;
		this._buffer = []; // array of {text, stream}
		this._throttleTimer = null;
		this.init();
	}

	init() {
		const fader = document.createElement("scroll-fader");
		this.cellNode.appendChild(fader);

		this._startEl = html`<pre class="cell-text-inner"></pre>`;
		this._marker = html`<div class="cell-lines-dropped" hidden></div>`;
		// this._marker = html`<div class="cell-lines-dropped"><div>123 lines dropped</div></div>`;
		this._restEl = html`<pre class="cell-text-inner"></pre>`;

		fader.inner.appendChild(this._restEl);
		fader.inner.appendChild(this._marker);
		fader.inner.appendChild(this._startEl);
	}

	send(data) {
		this._buffer.push({ text: data.text, stream: data.stream || "stdout" });
		if (this._startLines < START_MAX || this._restLines < REST_MAX) {
			this._flush();
		} else if (!this._throttleTimer) {
			this._throttleTimer = setTimeout(() => this._flush(), 100);
		}
	}

	_flush() {
		this._throttleTimer = null;

		// Fill start section up to START_MAX lines (never purged)
		while (this._startLines < START_MAX && this._buffer.length > 0) {
			const entry = this._buffer[0];
			const lines = countNewlines(entry.text);
			const needed = START_MAX - this._startLines;

			if (lines <= needed) {
				for (const node of this.ansi.parse(entry.text, entry.stream))
					this._startEl.appendChild(node);
				this._startLines += lines;
				this._buffer.shift();
			} else {
				// Split: first `needed` lines go to start, remainder stays in buffer
				const [head, tail] = splitAtLine(entry.text, needed);
				for (const node of this.ansi.parse(head, entry.stream))
					this._startEl.appendChild(node);
				this._startLines += needed;
				this._buffer[0] = { text: tail, stream: entry.stream };
			}
		}

		// Trim buffer to last REST_MAX lines, counting dropped
		let bufLines = 0;
		for (const entry of this._buffer) bufLines += countNewlines(entry.text);
		while (bufLines > REST_MAX && this._buffer.length > 0) {
			const lines = countNewlines(this._buffer[0].text);
			this._droppedLines += lines;
			bufLines -= lines;
			this._buffer.shift();
		}

		// Parse and append to rest section
		for (const { text, stream } of this._buffer) {
			this._restLines += countNewlines(text);
			for (const node of this.ansi.parse(text, stream))
				this._restEl.appendChild(node);
		}
		this._buffer = [];

		// Trim rest DOM to REST_MAX lines, counting dropped
		if (this._restLines > REST_MAX) {
			const excess = this._restLines - REST_MAX;
			let removed = 0;
			while (removed < excess && this._restEl.firstChild) {
				removed += countNewlines(this._restEl.firstChild.textContent);
				this._restEl.removeChild(this._restEl.firstChild);
			}
			this._droppedLines += removed;
			this._restLines -= removed;
		}

		// Update marker
		if (this._droppedLines > 0) {
			this._marker.innerHTML = `<div>${this._droppedLines} lines dropped</div>`;
			this._marker.removeAttribute("hidden");
		}
	}
}
