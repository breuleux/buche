import { html } from "./utils.js";
import { History } from "./history.js";

let focusedPrompt = null;

function applyRangesToText(text, ranges) {
  const points = new Set([0, text.length]);
  for (const { start, end } of ranges) {
    if (start >= 0 && start <= text.length) {
      points.add(start);
    }
    if (end >= 0 && end <= text.length) {
      points.add(end);
    }
  }
  const boundaries = [...points].sort((a, b) => a - b);
  const frag = document.createDocumentFragment();
  for (let i = 0; i < boundaries.length - 1; i++) {
    const s = boundaries[i];
    const e = boundaries[i + 1];
    const seg = text.slice(s, e);
    if (!seg) {
      continue;
    }
    const classes = ranges
      .filter((r) => r.start <= s && r.end >= e)
      .map((r) => r.cls);
    const span = document.createElement("span");
    span.textContent = seg;
    if (classes.length > 0) {
      span.className = classes.join(" ");
    }
    frag.appendChild(span);
  }
  return frag;
}

const EDITOR_OPTIONS = {
  value: "",
  language: "plaintext",
  theme: "vs-dark",
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  lineNumbers: "off",
  renderLineHighlight: "none",
  overviewRulerLanes: 0,
  folding: false,
  wordWrap: "on",
  fontSize: 13,
  fontFamily: "Consolas, Menlo, monospace",
  padding: { top: 0, bottom: 0 },
  lineHeight: 20,
  quickSuggestions: false,
  suggestOnTriggerCharacters: false,
  acceptSuggestionOnEnter: "off",
  tabCompletion: "off",
  wordBasedSuggestions: "off",
  parameterHints: { enabled: false },
  suggest: { showWords: false },
  glyphMargin: false,
  lineDecorationsWidth: 0,
  lineNumbersMinChars: 0,
  scrollbar: {
    vertical: "hidden",
    horizontal: "hidden",
    alwaysConsumeMouseWheel: false,
  },
};

class Prompt {
  constructor({
    sideHtml,
    tabHtml,
    tag,
    targetCellId,
    language,
    buche,
    onAfterSubmit,
    onPrev,
    onNext,
    onParseRequest,
    history,
  }) {
    this.tag = tag;
    this.targetCellId = targetCellId;
    this._buche = buche;
    this._onAfterSubmit = onAfterSubmit;
    this._onParseRequest = onParseRequest;
    this._history = history ?? null;
    this._echoes = new Map();
    this._editor = null;
    this._decorations = null;
    this._highlightRanges = [];
    this._language = language ?? "plaintext";

    this._sideHtml = sideHtml;

    this.labelEl = document.createElement("div");
    this.labelEl.className = "input-prompt";
    this.labelEl.innerHTML = sideHtml;

    this.editorEl = document.createElement("div");
    this.editorEl.className = "prompt-editor";

    // Wrapper holds label + editor, shown only when active.
    this.el = document.createElement("div");
    this.el.className = "prompt-wrapper";
    this.el.appendChild(this.labelEl);
    this.el.appendChild(this.editorEl);

    this.tabEl = document.createElement("div");
    this.tabEl.className = "prompt-tab";
    this.tabEl.innerHTML = tabHtml;

    this._onPrev = onPrev;
    this._onNext = onNext;
  }

  init() {
    this._editor = monaco.editor.create(this.editorEl, {
      ...EDITOR_OPTIONS,
      language: this._language,
    });

    this._editor.onDidFocusEditorWidget(() => {
      focusedPrompt = this;
    });

    this._editor.addCommand(monaco.KeyCode.Enter, () => {
      const value = focusedPrompt?._editor.getValue().trim();
      if (value) {
        focusedPrompt._submit(value);
      }
    });

    this._editor.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.Enter, () => {
      focusedPrompt?._editor.trigger("keyboard", "type", { text: "\n" });
    });

    this._editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.LeftArrow,
      () => focusedPrompt?._onPrev(),
    );
    this._editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.RightArrow,
      () => focusedPrompt?._onNext(),
    );

    this._editor.addCommand(monaco.KeyCode.UpArrow, () => {
      if (focusedPrompt?._editor.getPosition()?.lineNumber === 1) {
        focusedPrompt._history?.prev();
      } else {
        focusedPrompt?._editor.trigger("keyboard", "cursorUp", null);
      }
    });
    this._editor.addCommand(monaco.KeyCode.DownArrow, () => {
      const editor = focusedPrompt?._editor;
      const atLastLine =
        editor?.getPosition()?.lineNumber ===
        editor?.getModel()?.getLineCount();
      if (atLastLine) {
        focusedPrompt._history?.next();
      } else {
        editor?.trigger("keyboard", "cursorDown", null);
      }
    });

    this._editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.UpArrow, () => {
      focusedPrompt?._history?.prev(focusedPrompt);
    });
    this._editor.addCommand(
      monaco.KeyMod.Alt | monaco.KeyCode.DownArrow,
      () => {
        focusedPrompt?._history?.next(focusedPrompt);
      },
    );

    const updateHeight = () => {
      const height = this._editor.getContentHeight();
      this.editorEl.style.height = `${height}px`;
      this._editor.layout();
    };
    this._editor.onDidContentSizeChange(updateHeight);
    updateHeight();

    this._decorations = this._editor.createDecorationsCollection([]);

    this._editor.onDidChangeModelContent((e) => {
      if (!e.isFlush) this._history?.cancelNavigation();
    });

    if (this._onParseRequest) {
      this._editor.onDidChangeModelContent(() => {
        const text = this._editor.getValue();
        const pos = this._editor.getPosition();
        const position = pos
          ? this._editor.getModel().getOffsetAt(pos)
          : text.length;
        const request_id = crypto.randomUUID();
        this._onParseRequest(request_id);
        this._buche.sendCommand({
          type: "parse",
          text,
          position,
          want_completions: false,
          request_id,
          cell_id: this.targetCellId,
        });
      });
    }
  }

  applyHighlight(ranges) {
    this._highlightRanges = ranges;
    if (!this._editor) {
      return;
    }
    const model = this._editor.getModel();
    this._decorations.set(
      ranges.map(({ start, end, cls }) => ({
        range: monaco.Range.fromPositions(
          model.getPositionAt(start),
          model.getPositionAt(end),
        ),
        options: { inlineClassName: cls },
      })),
    );
  }

  _submit(value) {
    let cell_id;
    if (this.targetCellId?.includes(".")) {
      const prefix = this.targetCellId.slice(
        0,
        this.targetCellId.lastIndexOf("."),
      );
      cell_id = `${prefix}.${crypto.randomUUID()}`;
    } else {
      cell_id = crypto.randomUUID();
    }
    this._history?.push({
      text: value,
      tag: this.tag,
      target_cell_id: this.targetCellId,
    });
    this._echoes.set(cell_id, this.echo());
    this._buche.sendCommand({ type: "run", text: value, cell_id });
    this._editor.setValue("");
    this._onAfterSubmit(cell_id);
  }

  getValue() {
    return this._editor?.getValue() ?? "";
  }

  setValue(text) {
    if (!this._editor) return;
    this._editor.setValue(text);
    const model = this._editor.getModel();
    if (model) {
      const lastLine = model.getLineCount();
      this._editor.setPosition({
        lineNumber: lastLine,
        column: model.getLineLength(lastLine) + 1,
      });
    }
  }

  echo() {
    const text = this._editor?.getValue() ?? "";
    const label = document.createElement("div");
    label.className = "cell-input-label";
    label.innerHTML = this._sideHtml;
    const body = document.createElement("pre");
    body.className = "cell-input-body";
    if (this._highlightRanges.length > 0) {
      body.appendChild(applyRangesToText(text, this._highlightRanges));
    } else {
      body.textContent = text;
      monaco.editor.colorize(text, this._language, {}).then((highlighted) => {
        body.innerHTML = highlighted;
      });
    }
    return html`<div class="cell-input">${label}${body}</div>`;
  }

  disable() {
    this._editor?.updateOptions({ readOnly: true });
  }
  enable() {
    this._editor?.updateOptions({ readOnly: false });
  }
  focus() {
    this._editor?.focus();
  }
  layout() {
    this._editor?.layout();
  }

  setSideHtml(html) {
    this._sideHtml = html;
    this.labelEl.innerHTML = html;
  }

  takeEcho(cell_id) {
    const node = this._echoes.get(cell_id);
    this._echoes.delete(cell_id);
    return node;
  }
}

export class PromptCollection {
  constructor(container, buche) {
    this._buche = buche;
    this._prompts = [];
    this._activeIdx = 0;
    this._container = container;
    this._monacoReady = false;
    this.onAfterSubmit = (_cell_id) => {};
    this._parseRequests = new Map();
    this._history = new History({
      buche,
      getPrompts: () => this._prompts,
      getActive: () => this._active,
      activate: (prompt) => {
        const idx = this._prompts.indexOf(prompt);
        if (idx !== -1) this._activate(idx);
      },
    });

    this._tabBar = document.createElement("div");
    this._tabBar.id = "prompt-tabs";
    container.insertAdjacentElement("afterend", this._tabBar);

    const vsBase = `file://${buche.vsBase}`;
    window.MonacoEnvironment = {
      getWorkerUrl(_moduleId, _label) {
        return `data:text/javascript;charset=utf-8,${encodeURIComponent(`
          self.MonacoEnvironment = { baseUrl: '${vsBase}/' };
          importScripts('${vsBase}/base/worker/workerMain.js');
        `)}`;
      },
    };

    const loaderScript = document.createElement("script");
    loaderScript.src = `${vsBase}/loader.js`;
    loaderScript.onload = () => {
      require.config({ paths: { vs: vsBase } });
      require(["vs/editor/editor.main"], () => {
        this._monacoReady = true;
        for (const p of this._prompts) {
          p.init();
        }
        if (this._prompts.length > 0) {
          this._activate(0);
        }
      });
    };
    document.head.appendChild(loaderScript);
  }

  addPrompt({ side_html, tab_html, tag, target_cell_id, language }) {
    let prompt;
    const onParseRequest = (request_id) =>
      this._parseRequests.set(request_id, prompt);
    prompt = new Prompt({
      sideHtml: side_html,
      tabHtml: tab_html,
      tag,
      targetCellId: target_cell_id,
      language,
      buche: this._buche,
      onAfterSubmit: (cell_id) => this.onAfterSubmit(cell_id),
      onPrev: () => this._move(-1),
      onNext: () => this._move(1),
      onParseRequest,
      history: this._history,
    });
    prompt.tabEl.addEventListener("click", () => {
      this._activate(this._prompts.indexOf(prompt));
    });
    this._container.appendChild(prompt.el);
    this._tabBar.appendChild(prompt.tabEl);
    this._prompts.push(prompt);
    if (this._monacoReady) {
      prompt.init();
      this._activate(this._prompts.length - 1);
    }
    return prompt;
  }

  _activate(idx) {
    const prev = this._prompts[this._activeIdx];
    prev?.el.classList.remove("active");
    prev?.tabEl.classList.remove("active");

    this._activeIdx = idx;

    const next = this._prompts[idx];
    next.el.classList.add("active");
    next.tabEl.classList.add("active");
    next.layout();
    next.focus();
  }

  _move(delta) {
    const n = this._prompts.length;
    this._activate((this._activeIdx + delta + n) % n);
  }

  get _active() {
    return this._prompts[this._activeIdx];
  }

  get activeIdx() {
    return this._activeIdx;
  }

  disable() {
    this._active?.disable();
  }
  enable() {
    for (const p of this._prompts) {
      p.enable();
    }
  }
  focus() {
    this._active?.focus();
  }
  takeEcho(cell_id) {
    return this._active?.takeEcho(cell_id);
  }

  setPrompt({ target_cell_id, side_html }) {
    const prompt = this._prompts.find((p) => p.targetCellId === target_cell_id);
    if (prompt) {
      prompt.setSideHtml(side_html);
    }
  }

  applyHighlight({ request_id, ranges }) {
    const prompt = this._parseRequests.get(request_id);
    if (!prompt) {
      return;
    }
    this._parseRequests.delete(request_id);
    prompt.applyHighlight(ranges);
  }
}
