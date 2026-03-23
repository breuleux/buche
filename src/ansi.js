// Standard 16 ANSI colors
const C16 = [
	"#1c1c1c",
	"#cc0000",
	"#4e9a06",
	"#c4a000",
	"#3465a4",
	"#75507b",
	"#06989a",
	"#d3d7cf",
	"#555753",
	"#ef2929",
	"#8ae234",
	"#fce94f",
	"#729fcf",
	"#ad7fa8",
	"#34e2e2",
	"#eeeeec",
];

function c256(n) {
	if (n < 16) return C16[n];
	if (n >= 232) {
		const v = Math.round(((n - 232) * 255) / 23);
		return `rgb(${v},${v},${v})`;
	}
	const i = n - 16,
		r = Math.floor(i / 36),
		g = Math.floor(i / 6) % 6,
		b = i % 6;
	const x = (v) => (v ? v * 40 + 55 : 0);
	return `rgb(${x(r)},${x(g)},${x(b)})`;
}

const SGR_RE = /\x1b\[([0-9;]*)m/g;
const INCOMPLETE_RE = /\x1b(?:\[[0-9;]*)?$/;

export class AnsiParser {
	constructor() {
		this.fg = null;
		this.bg = null;
		this.bold = false;
		this.italic = false;
		this.underline = false;
		this._buf = "";
	}

	// Apply one SGR code, return how many extra codes were consumed.
	_apply(codes, i) {
		const c = codes[i];
		if (c === 0) {
			this.fg = this.bg = null;
			this.bold = this.italic = this.underline = false;
		} else if (c === 1) {
			this.bold = true;
		} else if (c === 3) {
			this.italic = true;
		} else if (c === 4) {
			this.underline = true;
		} else if (c === 22) {
			this.bold = false;
		} else if (c === 23) {
			this.italic = false;
		} else if (c === 24) {
			this.underline = false;
		} else if (c >= 30 && c <= 37) {
			this.fg = C16[c - 30];
		} else if (c === 38 && codes[i + 1] === 5) {
			this.fg = c256(codes[i + 2]);
			return 2;
		} else if (c === 38 && codes[i + 1] === 2) {
			this.fg = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`;
			return 4;
		} else if (c === 39) {
			this.fg = null;
		} else if (c >= 40 && c <= 47) {
			this.bg = C16[c - 40];
		} else if (c === 48 && codes[i + 1] === 5) {
			this.bg = c256(codes[i + 2]);
			return 2;
		} else if (c === 48 && codes[i + 1] === 2) {
			this.bg = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`;
			return 4;
		} else if (c === 49) {
			this.bg = null;
		} else if (c >= 90 && c <= 97) {
			this.fg = C16[c - 90 + 8];
		} else if (c >= 100 && c <= 107) {
			this.bg = C16[c - 100 + 8];
		}
		return 0;
	}

	_makeSpan(text, streamClass) {
		const span = document.createElement("span");
		span.className = `text-${streamClass}`;
		let style = "";
		if (this.fg) style += `color:${this.fg};`;
		if (this.bg) style += `background:${this.bg};`;
		if (this.bold) style += "font-weight:bold;";
		if (this.italic) style += "font-style:italic;";
		if (this.underline) style += "text-decoration:underline;";
		if (style) span.style.cssText = style;
		span.textContent = text;
		return span;
	}

	// Returns an array of spans.
	parse(text, streamClass) {
		const input = this._buf + text;
		this._buf = "";

		// Hold back any trailing incomplete escape sequence for the next chunk.
		const tail = INCOMPLETE_RE.exec(input);
		const src = tail ? input.slice(0, tail.index) : input;
		if (tail) this._buf = tail[0];

		const nodes = [];
		let last = 0;
		SGR_RE.lastIndex = 0;

		for (const m of src.matchAll(SGR_RE)) {
			if (m.index > last)
				nodes.push(this._makeSpan(src.slice(last, m.index), streamClass));
			last = m.index + m[0].length;
			const codes = m[1] === "" ? [0] : m[1].split(";").map(Number);
			for (let i = 0; i < codes.length; i++) i += this._apply(codes, i);
		}

		if (last < src.length)
			nodes.push(this._makeSpan(src.slice(last), streamClass));
		return nodes;
	}
}
