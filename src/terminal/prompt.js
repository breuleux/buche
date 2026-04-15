import { html } from "./utils.js";
import { History } from "./history.js";

let focusedPrompt = null;
let lastEditWasDeletion = false;

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
  inlineSuggest: { enabled: true },
  glyphMargin: false,
  lineDecorationsWidth: 0,
  lineNumbersMinChars: 0,
  scrollbar: {
    vertical: "hidden",
    horizontal: "hidden",
    alwaysConsumeMouseWheel: false,
  },
};

function _getHistoryFilter(editor, isDraft) {
  const sel = editor.getSelection();
  if (sel && !sel.isEmpty()) {
    return editor.getModel().getValueInRange(sel);
  }
  if (isDraft) {
    const model = editor.getModel();
    const pos = editor.getPosition();
    if (pos && model) {
      const lastLine = model.getLineCount();
      if (
        pos.lineNumber === lastLine &&
        pos.column > model.getLineLength(lastLine)
      ) {
        return editor.getValue() || null;
      }
    }
  }
  return null;
}

function _editorCommands() {
  return {
    submit: {
      trigger: monaco.KeyCode.Enter,
      run() {
        const value = focusedPrompt?._editor.getValue().trim();
        if (value) {
          focusedPrompt._submit(value);
        }
      },
    },

    newline: {
      trigger: monaco.KeyMod.Shift | monaco.KeyCode.Enter,
      run() {
        focusedPrompt?._editor.trigger("keyboard", "type", { text: "\n" });
      },
    },

    prevPrompt: {
      trigger: monaco.KeyMod.CtrlCmd | monaco.KeyCode.LeftArrow,
      run() {
        focusedPrompt?._promptCollection._move(-1);
      },
    },
    nextPrompt: {
      trigger: monaco.KeyMod.CtrlCmd | monaco.KeyCode.RightArrow,
      run() {
        focusedPrompt?._promptCollection._move(1);
      },
    },

    prevHistory: {
      trigger: monaco.KeyCode.UpArrow,
      run() {
        const editor = focusedPrompt?._editor;
        if (!editor) return;
        if (editor.getPosition()?.lineNumber === 1) {
          const history = focusedPrompt._promptCollection._history;
          history?.prev(null, _getHistoryFilter(editor, history._idx === -1));
        } else {
          editor.trigger("keyboard", "cursorUp", null);
        }
      },
    },
    nextHistory: {
      trigger: monaco.KeyCode.DownArrow,
      run() {
        const editor = focusedPrompt?._editor;
        if (!editor) return;
        const atLastLine =
          editor.getPosition()?.lineNumber ===
          editor.getModel()?.getLineCount();
        if (atLastLine) {
          const history = focusedPrompt._promptCollection._history;
          history?.next(null, _getHistoryFilter(editor, history._idx === -1));
        } else {
          editor.trigger("keyboard", "cursorDown", null);
        }
      },
    },

    prevHistorySpecific: {
      trigger: monaco.KeyMod.Alt | monaco.KeyCode.UpArrow,
      run() {
        const editor = focusedPrompt?._editor;
        if (!editor) return;
        const history = focusedPrompt._promptCollection._history;
        history?.prev(
          focusedPrompt,
          _getHistoryFilter(editor, history._idx === -1),
        );
      },
    },
    nextHistorySpecific: {
      trigger: monaco.KeyMod.Alt | monaco.KeyCode.DownArrow,
      run() {
        const editor = focusedPrompt?._editor;
        if (!editor) return;
        const history = focusedPrompt._promptCollection._history;
        history?.next(
          focusedPrompt,
          _getHistoryFilter(editor, history._idx === -1),
        );
      },
    },

    close: {
      trigger: monaco.KeyMod.WinCtrl | monaco.KeyCode.KeyD,
      run() {
        const prompt = focusedPrompt;
        if (!prompt) return;
        prompt._promptCollection._buche.sendCommand({
          type: "close",
          cell_id: prompt.targetCellId,
        });
      },
    },

    deleteWordLeft: {
      trigger: monaco.KeyMod.WinCtrl | monaco.KeyCode.KeyW,
      run() {
        const editor = focusedPrompt?._editor;
        if (!editor) return;
        const model = editor.getModel();
        const pos = editor.getPosition();
        if (!model || !pos) return;
        const offset = model.getOffsetAt(pos);
        const text = model.getValue();
        let i = offset;
        while (i > 0 && (text[i - 1] === " " || text[i - 1] === "\t")) i--;
        while (
          i > 0 &&
          text[i - 1] !== " " &&
          text[i - 1] !== "\t" &&
          text[i - 1] !== "\n"
        )
          i--;
        if (i === offset) return;
        const startPos = model.getPositionAt(i);
        editor.executeEdits("ctrl-w", [
          {
            range: new monaco.Range(
              startPos.lineNumber,
              startPos.column,
              pos.lineNumber,
              pos.column,
            ),
            text: "",
          },
        ]);
      },
    },

    acceptHistorySuggestion: {
      trigger: monaco.KeyCode.RightArrow,
      run() {
        const editor = focusedPrompt?._editor;
        if (!editor) return;
        const model = editor.getModel();
        const pos = editor.getPosition();
        const atEnd =
          pos &&
          model &&
          pos.lineNumber === model.getLineCount() &&
          pos.column > model.getLineLength(pos.lineNumber);
        if (atEnd) {
          editor.trigger(
            "keyboard",
            "editor.action.inlineSuggest.commit",
            null,
          );
        } else {
          editor.trigger("keyboard", "cursorRight", null);
        }
      },
    },
  };
}

class Prompt {
  constructor({
    sideHtml,
    tabHtml,
    tag,
    targetCellId,
    language,
    promptCollection,
  }) {
    this.tag = tag;
    this.targetCellId = targetCellId;
    this._promptCollection = promptCollection;
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
  }

  init() {
    this._editor = monaco.editor.create(this.editorEl, {
      ...EDITOR_OPTIONS,
      language: this._language,
    });

    this._editor.onDidFocusEditorWidget(() => {
      focusedPrompt = this;
    });

    for (let spec of Object.values(_editorCommands())) {
      this._editor.addCommand(spec.trigger, spec.run);
    }

    const updateHeight = () => {
      const height = this._editor.getContentHeight();
      this.editorEl.style.height = `${height}px`;
      this._editor.layout();
    };
    this._editor.onDidContentSizeChange(updateHeight);
    updateHeight();

    this._decorations = this._editor.createDecorationsCollection([]);

    this._editor.onDidChangeModelContent((e) => {
      if (!e.isFlush) {
        this._promptCollection._history?.cancelNavigation();
        lastEditWasDeletion = e.changes.some(
          (c) => c.rangeLength > 0 && c.text === "",
        );
      }
    });

    this._editor.onDidChangeModelContent(() => {
      const text = this._editor.getValue();
      const pos = this._editor.getPosition();
      const position = pos
        ? this._editor.getModel().getOffsetAt(pos)
        : text.length;
      const request_id = crypto.randomUUID();
      this._promptCollection._parseRequests.set(request_id, this);
      this._promptCollection._buche.sendCommand({
        type: "parse",
        text,
        position,
        want_completions: false,
        request_id,
        cell_id: this.targetCellId,
      });
    });
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
    this._promptCollection._history?.push({
      text: value,
      tag: this.tag,
      target_cell_id: this.targetCellId,
    });
    this._echoes.set(cell_id, this.echo());
    this._promptCollection._buche.sendCommand({
      type: "run",
      text: value,
      cell_id,
    });
    this._editor.setValue("");
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

  selectSubstring(needle) {
    if (!this._editor || !needle) return;
    const text = this._editor.getValue();
    const idx = text.indexOf(needle);
    if (idx === -1) return;
    const model = this._editor.getModel();
    const start = model.getPositionAt(idx);
    const end = model.getPositionAt(idx + needle.length);
    this._editor.setSelection(
      new monaco.Range(
        start.lineNumber,
        start.column,
        end.lineNumber,
        end.column,
      ),
    );
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
        this._registerHistoryCompletions();
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

  _registerHistoryCompletions() {
    const history = this._history;
    monaco.languages.registerInlineCompletionsProvider("*", {
      provideInlineCompletions(model, position, _context, _token) {
        const text = model.getValue();
        const offset = model.getOffsetAt(position);
        if (!text || offset !== text.length || lastEditWasDeletion)
          return { items: [] };
        const entries = history._entries;
        for (let i = entries.length - 1; i >= 0; i--) {
          const { text: entryText } = entries[i];
          if (entryText.startsWith(text) && entryText.length > text.length) {
            return {
              items: [
                {
                  insertText: entryText.slice(text.length),
                  range: new monaco.Range(
                    position.lineNumber,
                    position.column,
                    position.lineNumber,
                    position.column,
                  ),
                },
              ],
            };
          }
        }
        return { items: [] };
      },
      freeInlineCompletions() {},
    });
  }

  addPrompt({ side_html, tab_html, tag, target_cell_id, language }) {
    const prompt = new Prompt({
      sideHtml: side_html,
      tabHtml: tab_html,
      tag,
      targetCellId: target_cell_id,
      language,
      promptCollection: this,
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
