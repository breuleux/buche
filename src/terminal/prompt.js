import { tinykeys } from "tinykeys";
import { html, addressMatchesProcess } from "./utils.js";
import { clearFocusedCell } from "./cell/cell.js";

let focusedPrompt = null;
let _moveToGroup = null; // (delta: number) => void — set by ZoneManager
export function setMoveToGroupHandler(fn) { _moveToGroup = fn; }

// ── Module-level Monaco / tinykeys singletons ────────────────────────────
// Monaco must be loaded exactly once even when multiple PromptCollections exist.

let _monacoLoadState = "idle"; // "idle" | "loading" | "ready"
const _monacoReadyCallbacks = [];
let _keysRegistered = false;
let _completionsRegistered = false;

function _onMonacoReady(cb) {
  if (_monacoLoadState === "ready") {
    cb();
  } else {
    _monacoReadyCallbacks.push(cb);
  }
}

function _initMonaco(vsBase) {
  if (_monacoLoadState !== "idle") return;
  _monacoLoadState = "loading";

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
      _monacoLoadState = "ready";
      if (!_completionsRegistered) {
        _completionsRegistered = true;
        _registerHistoryCompletions();
      }
      for (const cb of _monacoReadyCallbacks.splice(0)) cb();
    });
  };
  document.head.appendChild(loaderScript);
}

function _registerHistoryCompletions() {
  monaco.languages.registerInlineCompletionsProvider("*", {
    provideInlineCompletions(model, position, _context, _token) {
      const text = model.getValue();
      const offset = model.getOffsetAt(position);
      if (!text || offset !== text.length || lastEditWasDeletion)
        return { items: [] };
      const filigrane = focusedPrompt?._filigrane;
      if (!filigrane || !filigrane.startsWith(text) || filigrane === text)
        return { items: [] };
      return {
        items: [
          {
            insertText: filigrane.slice(text.length),
            range: new monaco.Range(
              position.lineNumber,
              position.column,
              position.lineNumber,
              position.column,
            ),
          },
        ],
      };
    },
    freeInlineCompletions() {},
  });
}

export function isPromptFocused() {
  return focusedPrompt !== null;
}
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


function _parseMonacoKey(keyStr) {
  const parts = keyStr.split("+");
  let mods = 0;
  let keyCode = 0;
  for (const part of parts) {
    switch (part) {
      case "Control": mods |= monaco.KeyMod.WinCtrl; break;
      case "Alt":     mods |= monaco.KeyMod.Alt; break;
      case "Shift":   mods |= monaco.KeyMod.Shift; break;
      case "Meta":
      case "Cmd":     mods |= monaco.KeyMod.CtrlCmd; break;
      default:
        if (part.length === 1) {
          keyCode = monaco.KeyCode[`Key${part.toUpperCase()}`] ?? 0;
        }
    }
  }
  return mods | keyCode;
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

    prevGroup: {
      trigger: monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.LeftArrow,
      run() { _moveToGroup?.(-1); },
    },
    nextGroup: {
      trigger: monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.RightArrow,
      run() { _moveToGroup?.(1); },
    },

    prevHistory: {
      trigger: monaco.KeyCode.UpArrow,
      run() {
        const editor = focusedPrompt?._editor;
        if (!editor) return;
        if (editor.getPosition()?.lineNumber === 1) {
          focusedPrompt?._sendHistoryNavigate("prev");
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
          if (focusedPrompt?._navDraft !== null) {
            focusedPrompt._sendHistoryNavigate("next");
          }
        } else {
          editor.trigger("keyboard", "cursorDown", null);
        }
      },
    },

    close: {
      trigger: monaco.KeyMod.WinCtrl | monaco.KeyCode.KeyD,
      run() {
        const prompt = focusedPrompt;
        if (!prompt) return;
        prompt._promptCollection._buche.sendCommand({
          type: "prompt_close",
          to: prompt.address,
        });
      },
    },

    clearInput: {
      trigger: monaco.KeyMod.WinCtrl | monaco.KeyCode.KeyC,
      run() {
        const editor = focusedPrompt?._editor;
        if (!editor) return;
        editor.setValue("");
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

    tabComplete: {
      trigger: monaco.KeyCode.Tab,
      run() {
        const prompt = focusedPrompt;
        if (!prompt) return;
        const editor = prompt._editor;
        if (!editor) return;
        const text = editor.getValue();
        const pos = editor.getPosition();
        const model = editor.getModel();
        if (!pos || !model) return;
        const position = model.getOffsetAt(pos);
        const left = text.slice(0, position);
        const prefix = /(\S*)$/.exec(left)?.[1] ?? "";
        const request_id = crypto.randomUUID();
        prompt._promptCollection._completionRequests.set(request_id, {
          prompt,
          prefix,
          position,
        });
        prompt._promptCollection._buche.sendCommand({
          type: "parse",
          to: prompt.address,
          text,
          position,
          want_completions: true,
          request_id,
        });
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
    promptHtml,
    name,
    tag,
    promptId,
    address,
    language,
    bindings,
    color,
    promptCollection,
  }) {
    this.tag = tag;
    this.promptId = promptId;
    this.address = address;
    this._promptCollection = promptCollection;
    this._editor = null;
    this._decorations = null;
    this._highlightRanges = [];
    this._language = language ?? "plaintext";
    this._bindings = bindings
      ? Object.entries(bindings).map(([key, name]) => ({ key, name }))
      : [];
    this._navAnchorId = null;  // ID of currently displayed history entry
    this._navDraft = null;     // text saved before navigation started
    this._filigrane = null;    // inline suggestion from parse response

    this._promptHtml = promptHtml;

    this.labelEl = document.createElement("div");
    this.labelEl.className = "input-prompt";
    this.labelEl.innerHTML = promptHtml;

    this.editorEl = document.createElement("div");
    this.editorEl.className = "prompt-editor";

    // Wrapper holds label + editor, shown only when active.
    this.el = document.createElement("div");
    this.el.className = "prompt-wrapper";
    this.el.appendChild(this.labelEl);
    this.el.appendChild(this.editorEl);

    this._name = name;

    this.tabEl = document.createElement("div");
    this.tabEl.className = "prompt-tab";
    this.tabEl.textContent = name;

    this._color = null;
    if (color) this.setColor(color);
  }

  setColor(color) {
    this._color = color ?? null;
    const hue = color?.hue ?? 230;
    const chroma = color?.chroma ?? 0.12;
    this.tabEl.style.setProperty("--prompt-hue", hue);
    this.tabEl.style.setProperty("--prompt-chroma", chroma);
  }

  init() {
    this._editor = monaco.editor.create(this.editorEl, {
      ...EDITOR_OPTIONS,
      language: this._language,
    });

    this._editor.onDidFocusEditorWidget(() => {
      clearFocusedCell();
      focusedPrompt = this;
      this._promptCollection.onFocus?.();
    });

    for (let spec of Object.values(_editorCommands())) {
      this._editor.addCommand(spec.trigger, spec.run);
    }

    for (const { key, name } of this._bindings) {
      const trigger = _parseMonacoKey(key);
      if (!trigger) continue;
      this._editor.addCommand(trigger, () => {
        const editor = this._editor;
        if (!editor) return;
        const text = editor.getValue();
        const pos = editor.getPosition();
        const position = pos ? editor.getModel().getOffsetAt(pos) : text.length;
        this._promptCollection._buche.sendCommand({
          type: "prompt_binding",
          to: this.address,
          name,
          key,
          text,
          position,
        });
      });
    }

    const updateHeight = () => {
      const height = this._editor.getContentHeight();
      this.editorEl.style.height = `${height}px`;
      this._editor.layout();
    };
    this._editor.onDidContentSizeChange(updateHeight);
    new ResizeObserver(() => this._editor?.layout()).observe(this.editorEl);
    updateHeight();

    this._decorations = this._editor.createDecorationsCollection([]);

    this._editor.onDidChangeModelContent((e) => {
      if (!e.isFlush) {
        this._cancelNavigation();
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
        to: this.address,
        text,
        position,
        want_completions: false,
        request_id,
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
    this._cancelNavigation();
    const echoNode = this.echo();
    const echo_html = echoNode.outerHTML;
    this._promptCollection._buche.sendCommand({
      type: "prompt_submit",
      to: this.address,
      text: value,
      tag: this.tag,
      prompt_id: this.promptId,
      echo_html,
      prompt_color: this._color ?? undefined,
      zone: this._promptCollection._zoneName,
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
    label.innerHTML = this._promptHtml;
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

  setPromptHtml(promptHtml) {
    this._promptHtml = promptHtml;
    this.labelEl.innerHTML = promptHtml;
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

  _cancelNavigation() {
    if (this._navDraft === null && this._navAnchorId === null) return;
    for (const [id, p] of this._promptCollection._histNavRequests) {
      if (p === this) this._promptCollection._histNavRequests.delete(id);
    }
    this._navAnchorId = null;
    this._navDraft = null;
  }

  _sendHistoryNavigate(direction) {
    const editor = this._editor;
    if (!editor) return;
    const text = editor.getValue();
    const pos = editor.getPosition();
    const model = editor.getModel();
    const position = pos ? model.getOffsetAt(pos) : text.length;

    const isFirstNav = this._navDraft === null;
    if (isFirstNav && direction === "prev") {
      this._navDraft = text;
    }

    let filter = null;
    const sel = editor.getSelection();
    if (sel && !sel.isEmpty()) {
      filter = model.getValueInRange(sel);
    } else if (isFirstNav && pos && model) {
      const lastLine = model.getLineCount();
      if (pos.lineNumber === lastLine && pos.column > model.getLineLength(lastLine)) {
        filter = text || null;
      }
    }

    const request_id = crypto.randomUUID();
    this._promptCollection._histNavRequests.set(request_id, this);
    this._promptCollection._buche.sendCommand({
      type: "history_navigate",
      to: this.address,
      direction,
      anchor_id: this._navAnchorId,
      text,
      position,
      filter,
      tag: this.tag,
      request_id,
    });
  }
}

export class PromptCollection {
  constructor(container, buche, zoneName = "main") {
    this._buche = buche;
    this._zoneName = zoneName;
    this._prompts = [];
    this._activeIdx = 0;
    this._container = container;
    this._monacoReady = false;
    this.onFocus = null; // () => void — called when any prompt in this collection gains focus
    this.onActiveChanged = null; // (name: string) => void — called when the active prompt changes
    this.onPromptsChanged = null; // () => void — called when prompts are added or removed
    this.onActiveColorChanged = null; // () => void — called when the active prompt's color changes
    this._parseRequests = new Map();
    this._completionRequests = new Map();
    this._histNavRequests = new Map();

    this._tabBar = document.createElement("div");
    this._tabBar.className = "prompt-tabs";
    container.insertAdjacentElement("afterend", this._tabBar);

    if (!_keysRegistered) {
      _keysRegistered = true;
      tinykeys(window, {
        "$mod+ArrowLeft": (e) => {
          if (!focusedPrompt) return;
          e.preventDefault();
          focusedPrompt._promptCollection._move(-1);
        },
        "$mod+ArrowRight": (e) => {
          if (!focusedPrompt) return;
          e.preventDefault();
          focusedPrompt._promptCollection._move(1);
        },
        "Control+d": (e) => {
          if (!focusedPrompt) return;
          e.preventDefault();
          focusedPrompt._promptCollection._buche.sendCommand({
            type: "prompt_close",
            to: focusedPrompt.address,
          });
        },
      });
    }

    const vsBase = `file://${buche.vsBase}`;
    _initMonaco(vsBase);
    _onMonacoReady(() => {
      this._monacoReady = true;
      if (this._prompts.length > 0) {
        this._activate(0);
      }
      for (const p of this._prompts) {
        p.init();
      }
      if (this._prompts.length > 0) {
        this._prompts[this._activeIdx]?.focus();
      }
    });
  }

  addPrompt({ to, address, prompt, name, tag, language, bindings, color }) {
    const p = new Prompt({
      promptHtml: prompt,
      name,
      tag,
      promptId: JSON.stringify(address) + ":" + to.prompt,
      address,
      language,
      bindings,
      color,
      promptCollection: this,
    });
    p.tabEl.addEventListener("click", () => {
      this._activate(this._prompts.indexOf(p));
    });
    this._container.appendChild(p.el);
    this._tabBar.appendChild(p.tabEl);
    this._prompts.push(p);
    if (this._monacoReady) {
      this._activate(this._prompts.length - 1);
      p.init();
      requestAnimationFrame(() => p.focus());
    }
    return p;
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
    if (!document.activeElement?.closest?.(".cell")) next.focus();
    this.onActiveChanged?.(next._name);
  }

  get activeName() {
    return this._active?._name ?? null;
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

  layoutAll() {
    for (const p of this._prompts) p.layout();
  }

  removePromptsByProcess(process_id) {
    const toRemove = this._prompts.filter(
      (p) => addressMatchesProcess(p.address, process_id),
    );
    for (const p of toRemove) {
      p.el.remove();
      p.tabEl.remove();
    }
    const before = this._activeIdx;
    this._prompts = this._prompts.filter(
      (p) => !addressMatchesProcess(p.address, process_id),
    );
    if (this._prompts.length > 0) {
      this._activeIdx = Math.min(before, this._prompts.length - 1);
      this._activate(this._activeIdx);
    }
    this.onPromptsChanged?.();
  }

  setPrompt({ to, address, prompt, color }) {
    const promptId = JSON.stringify(address) + ":" + to.prompt;
    const p = this._prompts.find((p) => p.promptId === promptId);
    if (p) {
      p.setPromptHtml(prompt);
      if (color !== undefined) {
        p.setColor(color);
        if (p === this._active) this.onActiveColorChanged?.();
      }
    }
  }

  setInput({ to, address, text, position }) {
    const promptId = JSON.stringify(address) + ":" + to.prompt;
    const p = this._prompts.find((p) => p.promptId === promptId);
    if (!p?._editor) return;
    p._editor.setValue(text);
    if (position != null) {
      const model = p._editor.getModel();
      p._editor.setPosition(model.getPositionAt(position));
    }
  }

  applyHighlight({ request_id, ranges, filigrane }) {
    const prompt = this._parseRequests.get(request_id);
    if (!prompt) return;
    this._parseRequests.delete(request_id);
    prompt.applyHighlight(ranges);
    prompt._filigrane = filigrane ?? null;
  }

  applyHistoryNav({ request_id, direction, text, anchor_id, filter }) {
    const prompt = this._histNavRequests.get(request_id);
    if (!prompt) return;
    this._histNavRequests.delete(request_id);
    if (text === null) {
      if (direction === "next" && prompt._navDraft !== null) {
        const draft = prompt._navDraft;
        prompt._navAnchorId = null;
        prompt._navDraft = null;
        prompt.setValue(draft);
      }
      return;
    }
    prompt._navAnchorId = anchor_id;
    prompt.setValue(text);
    prompt.selectSubstring(filter);
  }

  applyComplete({ request_id, completions }) {
    const req = this._completionRequests.get(request_id);
    if (!req) return;
    this._completionRequests.delete(request_id);
    if (completions.length === 0) return;

    const { prompt, prefix, position } = req;
    const editor = prompt._editor;
    if (!editor) return;

    let insert;
    if (completions.length === 1) {
      insert = completions[0].value;
    } else {
      let common = completions[0].value;
      for (const { value } of completions) {
        while (!value.startsWith(common)) {
          common = common.slice(0, -1);
        }
      }
      if (common.length <= prefix.length) return;
      insert = common;
    }

    if (insert === prefix) return;

    const model = editor.getModel();
    const startPos = model.getPositionAt(position - prefix.length);
    const endPos = model.getPositionAt(position);
    editor.executeEdits("tab-complete", [
      {
        range: new monaco.Range(
          startPos.lineNumber,
          startPos.column,
          endPos.lineNumber,
          endPos.column,
        ),
        text: insert,
      },
    ]);
  }
}
