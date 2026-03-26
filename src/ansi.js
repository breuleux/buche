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

const INCOMPLETE_RE = /\x1b(?:\[[0-9;]*)?$/;

function makeSpan(text, streamClass, fg, bg, bold, italic, underline) {
  const span = document.createElement("span");
  span.className = `text-${streamClass}`;
  let style = "";
  if (fg) style += `color:${fg};`;
  if (bg) style += `background:${bg};`;
  if (bold) style += "font-weight:bold;";
  if (italic) style += "font-style:italic;";
  if (underline) style += "text-decoration:underline;";
  if (style) span.style.cssText = style;
  span.textContent = text;
  return span;
}

function stylesEq(a, b) {
  return (
    a.fg === b.fg &&
    a.bg === b.bg &&
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.stream === b.stream
  );
}

// TermBuffer: processes raw terminal output into DOM nodes.
// Handles \b (backspace), \r (carriage return), \n (linefeed),
// ANSI SGR (colors/styles), and \x1b[K (erase to EOL).
export class TermBuffer {
  constructor() {
    this.fg = null;
    this.bg = null;
    this.bold = false;
    this.italic = false;
    this.underline = false;
    this._esc = ""; // pending incomplete escape sequence
    this._cells = []; // current line: [{char, fg, bg, bold, italic, underline, stream}]
    this._col = 0; // cursor column
  }

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

  _put(ch, stream) {
    const cell = {
      char: ch,
      fg: this.fg,
      bg: this.bg,
      bold: this.bold,
      italic: this.italic,
      underline: this.underline,
      stream,
    };
    if (this._col < this._cells.length) {
      this._cells[this._col] = cell;
    } else {
      while (this._cells.length < this._col) {
        this._cells.push({
          char: " ",
          fg: null,
          bg: null,
          bold: false,
          italic: false,
          underline: false,
          stream,
        });
      }
      this._cells.push(cell);
    }
    this._col++;
  }

  // Convert current cells to a DocumentFragment of styled spans.
  _cellsToFrag() {
    const frag = document.createDocumentFragment();
    const cells = this._cells;
    let i = 0;
    while (i < cells.length) {
      const c0 = cells[i];
      let j = i + 1;
      while (j < cells.length && stylesEq(cells[j], c0)) j++;
      const text = cells
        .slice(i, j)
        .map((c) => c.char)
        .join("");
      frag.appendChild(
        makeSpan(
          text,
          c0.stream,
          c0.fg,
          c0.bg,
          c0.bold,
          c0.italic,
          c0.underline,
        ),
      );
      i = j;
    }
    return frag;
  }

  // Return a <span> wrapping the current partial line (non-destructive).
  currentLineNode() {
    if (this._cells.length === 0) return null;
    const span = document.createElement("span");
    const frag = this._cellsToFrag();
    while (frag.firstChild) span.appendChild(frag.firstChild);
    return span;
  }

  _handleCSI(params, cmd) {
    if (cmd === "m") {
      const codes = params === "" ? [0] : params.split(";").map(Number);
      for (let i = 0; i < codes.length; i++) i += this._apply(codes, i);
    } else if (cmd === "K") {
      const n = parseInt(params) || 0;
      if (n === 0)
        this._cells.splice(this._col); // erase cursor→EOL
      else if (n === 1) {
        this._cells.splice(0, this._col);
        this._col = 0;
      } // erase BOL→cursor
      else if (n === 2) {
        this._cells = [];
        this._col = 0;
      } // erase entire line
    }
    // Other sequences (cursor movement, screen ops) ignored for now.
  }

  // Process raw terminal text. Returns an array of DocumentFragments,
  // one per completed line (each fragment ends with a '\n' text node).
  // The current partial line is not returned; call currentLineNode() to get it.
  write(text, streamClass) {
    const input = this._esc + text;
    this._esc = "";

    // Hold back any trailing incomplete escape sequence.
    const tail = INCOMPLETE_RE.exec(input);
    const src = tail ? input.slice(0, tail.index) : input;
    if (tail) this._esc = tail[0];

    const lines = [];
    let i = 0;

    while (i < src.length) {
      const ch = src[i];

      if (ch === "\x1b" && src[i + 1] === "[") {
        const m = /^\x1b\[([0-9;]*)([A-Za-z~])/.exec(src.slice(i));
        if (m) {
          this._handleCSI(m[1], m[2]);
          i += m[0].length;
        } else {
          i++;
        }
      } else if (ch === "\x1b") {
        i++; // skip unknown escape
      } else if (ch === "\r") {
        this._col = 0;
        i++;
      } else if (ch === "\n") {
        const frag = this._cellsToFrag();
        frag.appendChild(document.createTextNode("\n"));
        lines.push(frag);
        this._cells = [];
        this._col = 0;
        i++;
      } else if (ch === "\b") {
        if (this._col > 0) this._col--;
        i++;
      } else if (ch === "\t") {
        const next = (Math.floor(this._col / 8) + 1) * 8;
        while (this._col < next) this._put(" ", streamClass);
        i++;
      } else if (ch >= " ") {
        this._put(ch, streamClass);
        i++;
      } else {
        i++; // skip other C0 controls
      }
    }

    return lines;
  }
}
