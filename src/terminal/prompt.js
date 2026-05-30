import { tinykeys } from "tinykeys";
import {
  EditorState,
  StateField,
  StateEffect,
  Compartment,
  EditorSelection,
  Transaction,
} from "@codemirror/state";
import { EditorView, keymap, Decoration, WidgetType } from "@codemirror/view";
import { html, addressMatchesProcess } from "./utils.js";
import { clearFocusedCell } from "./cell/cell.js";

let focusedPrompt = null;
let _moveToGroup = null;
export function setMoveToGroupHandler(fn) { _moveToGroup = fn; }

export function isPromptFocused() { return focusedPrompt !== null; }

let _keysRegistered = false;

// ── Ghost text (filigrane) ──────────────────────────────────────────────────

class GhostTextWidget extends WidgetType {
  constructor(text) { super(); this.text = text; }
  eq(other) { return this.text === other.text; }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-ghost-text";
    span.textContent = this.text;
    return span;
  }
  ignoreEvent() { return true; }
}

const ghostTextEffect = StateEffect.define();
const ghostTextField = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) {
      if (e.is(ghostTextEffect)) {
        return e.value === null
          ? Decoration.none
          : Decoration.set([
              Decoration.widget({ widget: new GhostTextWidget(e.value), side: 1 })
                .range(tr.state.doc.length),
            ]);
      }
    }
    return tr.docChanged ? Decoration.none : deco;
  },
  provide: f => EditorView.decorations.from(f),
});

// ── Highlight decorations ───────────────────────────────────────────────────

const highlightEffect = StateEffect.define();
const highlightField = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) {
      if (e.is(highlightEffect)) return e.value;
    }
    return deco.map(tr.changes);
  },
  provide: f => EditorView.decorations.from(f),
});

// ── Theme ───────────────────────────────────────────────────────────────────

const darkTheme = EditorView.theme({
  "&": { color: "#d4d4d4", backgroundColor: "transparent" },
  ".cm-content": { caretColor: "#d4d4d4", padding: "0", lineHeight: "20px" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#d4d4d4" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
    backgroundColor: "#264f78",
  },
  "::selection": { backgroundColor: "#264f78" },
  ".cm-line": { padding: "0" },
  ".cm-ghost-text": { opacity: "0.4" },
}, { dark: true });

// ── Key string conversion ───────────────────────────────────────────────────

function _parseCMKey(keyStr) {
  const modMap = { Control: "Ctrl", Alt: "Alt", Shift: "Shift", Meta: "Meta", Cmd: "Mod" };
  const parts = keyStr.split("+");
  const mods = [];
  let key = "";
  for (const part of parts) {
    if (modMap[part]) mods.push(modMap[part]);
    else key = part;
  }
  // Single ASCII letters must be lowercase: CodeMirror uses event.key which is
  // lowercase when Shift is not held, uppercase when it is. "Control+T" in config
  // means the T key (no Shift), so we need "Ctrl-t" not "Ctrl-T".
  if (key.length === 1 && /[A-Za-z]/.test(key)) key = key.toLowerCase();
  return key ? [...mods, key].join("-") : null;
}

// ── applyRangesToText ───────────────────────────────────────────────────────

function applyRangesToText(text, ranges) {
  const points = new Set([0, text.length]);
  for (const { start, end } of ranges) {
    if (start >= 0 && start <= text.length) points.add(start);
    if (end >= 0 && end <= text.length) points.add(end);
  }
  const boundaries = [...points].sort((a, b) => a - b);
  const frag = document.createDocumentFragment();
  for (let i = 0; i < boundaries.length - 1; i++) {
    const s = boundaries[i];
    const e = boundaries[i + 1];
    const seg = text.slice(s, e);
    if (!seg) continue;
    const classes = ranges
      .filter((r) => r.start <= s && r.end >= e)
      .map((r) => r.cls);
    const span = document.createElement("span");
    span.textContent = seg;
    if (classes.length > 0) span.className = classes.join(" ");
    frag.appendChild(span);
  }
  return frag;
}

// ── Prompt ──────────────────────────────────────────────────────────────────

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
    this._view = null;
    this._readOnly = null;
    this._highlightRanges = [];
    this._lastEditWasDeletion = false;
    this._language = language ?? "plaintext";
    this._bindings = bindings
      ? Object.entries(bindings).map(([key, name]) => ({ key, name }))
      : [];
    this._navAnchorId = null;
    this._navDraft = null;
    this._filigrane = null;

    this._promptHtml = promptHtml;

    this.labelEl = document.createElement("div");
    this.labelEl.className = "input-prompt";
    this.labelEl.innerHTML = promptHtml;

    this.editorEl = document.createElement("div");
    this.editorEl.className = "prompt-editor";

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
    const self = this;
    const readOnly = new Compartment();
    this._readOnly = readOnly;

    const userKeymap = this._bindings.flatMap(({ key, name }) => {
      const cmKey = _parseCMKey(key);
      if (!cmKey) return [];
      return [{
        key: cmKey,
        run: (view) => {
          const text = view.state.doc.toString();
          const pos = view.state.selection.main.head;
          self._promptCollection._buche.sendCommand({
            type: "prompt_binding",
            to: self.address,
            name,
            key,
            text,
            position: pos,
          });
          return true;
        },
      }];
    });

    const instanceKeymap = keymap.of([
      {
        key: "Enter",
        run: (view) => {
          const value = view.state.doc.toString().trim();
          if (value) self._submit(value);
          return true;
        },
      },
      {
        key: "Shift-Enter",
        run: (view) => {
          view.dispatch(view.state.replaceSelection("\n"));
          return true;
        },
      },
      {
        key: "Mod-ArrowLeft",
        run: () => { self._promptCollection._move(-1); return true; },
      },
      {
        key: "Mod-ArrowRight",
        run: () => { self._promptCollection._move(1); return true; },
      },
      {
        key: "Mod-Shift-ArrowLeft",
        run: () => { _moveToGroup?.(-1); return true; },
      },
      {
        key: "Mod-Shift-ArrowRight",
        run: () => { _moveToGroup?.(1); return true; },
      },
      {
        key: "ArrowUp",
        run: (view) => {
          const pos = view.state.selection.main.head;
          const line = view.state.doc.lineAt(pos);
          if (line.number === 1) {
            self._sendHistoryNavigate("prev");
            return true;
          }
          return false;
        },
      },
      {
        key: "ArrowDown",
        run: (view) => {
          const pos = view.state.selection.main.head;
          const doc = view.state.doc;
          const line = doc.lineAt(pos);
          if (line.number === doc.lines) {
            if (self._navDraft !== null) self._sendHistoryNavigate("next");
            return true;
          }
          return false;
        },
      },
      {
        key: "Ctrl-d",
        run: () => {
          self._promptCollection._buche.sendCommand({
            type: "prompt_close",
            to: self.address,
          });
          return true;
        },
      },
      {
        key: "Ctrl-c",
        run: (view) => {
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: "" },
            annotations: Transaction.userEvent.of("setValue"),
          });
          return true;
        },
      },
      {
        key: "Ctrl-w",
        run: (view) => {
          const pos = view.state.selection.main.from;
          const text = view.state.doc.toString();
          let i = pos;
          while (i > 0 && (text[i - 1] === " " || text[i - 1] === "\t")) i--;
          while (i > 0 && text[i - 1] !== " " && text[i - 1] !== "\t" && text[i - 1] !== "\n") i--;
          if (i < pos) view.dispatch({ changes: { from: i, to: pos } });
          return true;
        },
      },
      {
        key: "Tab",
        run: (view) => {
          const text = view.state.doc.toString();
          const pos = view.state.selection.main.head;
          const left = text.slice(0, pos);
          const prefix = /(\S*)$/.exec(left)?.[1] ?? "";
          const request_id = crypto.randomUUID();
          self._promptCollection._completionRequests.set(request_id, {
            prompt: self,
            prefix,
            position: pos,
          });
          self._promptCollection._buche.sendCommand({
            type: "parse",
            to: self.address,
            text,
            position: pos,
            want_completions: true,
            request_id,
          });
          return true;
        },
      },
      {
        key: "ArrowRight",
        run: (view) => {
          const sel = view.state.selection.main;
          if (sel.empty && sel.head === view.state.doc.length && self._filigrane) {
            const text = view.state.doc.toString();
            if (self._filigrane.startsWith(text) && self._filigrane !== text) {
              const suffix = self._filigrane.slice(text.length);
              const insertAt = view.state.doc.length;
              view.dispatch({
                changes: { from: insertAt, insert: suffix },
                selection: EditorSelection.cursor(insertAt + suffix.length),
                effects: ghostTextEffect.of(null),
                annotations: Transaction.userEvent.of("setValue"),
              });
              return true;
            }
          }
          return false;
        },
      },
      ...userKeymap,
    ]);

    this._view = new EditorView({
      state: EditorState.create({
        doc: "",
        extensions: [
          instanceKeymap,
          ghostTextField,
          highlightField,
          readOnly.of(EditorState.readOnly.of(false)),
          EditorView.lineWrapping,
          darkTheme,
          EditorView.updateListener.of((update) => {
            if (update.focusChanged) {
              if (update.view.hasFocus) {
                clearFocusedCell();
                focusedPrompt = self;
                self._promptCollection.onFocus?.();
              } else if (focusedPrompt === self) {
                focusedPrompt = null;
              }
            }
            if (update.docChanged) {
              const isSetValue = update.transactions.some(tr =>
                tr.isUserEvent("setValue"),
              );
              if (!isSetValue) {
                self._cancelNavigation();
                let isDeletion = false;
                for (const tr of update.transactions) {
                  tr.changes.iterChanges((fromA, toA, _fB, _tB, ins) => {
                    if (toA > fromA && ins.length === 0) isDeletion = true;
                  });
                }
                self._lastEditWasDeletion = isDeletion;
              }
              const text = update.state.doc.toString();
              const pos = update.state.selection.main.head;
              const request_id = crypto.randomUUID();
              self._promptCollection._parseRequests.set(request_id, self);
              self._promptCollection._buche.sendCommand({
                type: "parse",
                to: self.address,
                text,
                position: pos,
                want_completions: false,
                request_id,
              });
            }
          }),
        ],
      }),
      parent: this.editorEl,
    });
  }

  _updateGhostText() {
    if (!this._view) return;
    const text = this._view.state.doc.toString();
    const filigrane = this._filigrane;
    const sel = this._view.state.selection.main;
    const atEnd = sel.empty && sel.head === text.length;
    if (
      filigrane &&
      filigrane.startsWith(text) &&
      filigrane !== text &&
      !this._lastEditWasDeletion &&
      atEnd
    ) {
      this._view.dispatch({ effects: ghostTextEffect.of(filigrane.slice(text.length)) });
    } else {
      this._view.dispatch({ effects: ghostTextEffect.of(null) });
    }
  }

  applyHighlight(ranges) {
    this._highlightRanges = ranges;
    if (!this._view) return;
    const docLen = this._view.state.doc.length;

    // Merge class names for ranges at identical positions so that overlapping
    // decorations like sh-cmd + sh-invalid become one span with both classes.
    // CSS cascade (later rule wins) then resolves the visual priority.
    const byPos = new Map();
    for (const { start, end, cls } of ranges) {
      if (start >= end || start < 0 || end > docLen) continue;
      const key = `${start}:${end}`;
      if (!byPos.has(key)) byPos.set(key, { start, end, classes: [] });
      byPos.get(key).classes.push(cls);
    }

    const decos = [...byPos.values()]
      .sort((a, b) => a.start - b.start || a.end - b.end)
      .map(({ start, end, classes }) =>
        Decoration.mark({ class: classes.join(" ") }).range(start, end),
      );

    this._view.dispatch({
      effects: highlightEffect.of(Decoration.set(decos)),
    });
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
    this._view.dispatch({
      changes: { from: 0, to: this._view.state.doc.length, insert: "" },
      annotations: Transaction.userEvent.of("setValue"),
    });
  }

  getValue() {
    return this._view?.state.doc.toString() ?? "";
  }

  setValue(text) {
    if (!this._view) return;
    this._view.dispatch({
      changes: { from: 0, to: this._view.state.doc.length, insert: text },
      selection: EditorSelection.cursor(text.length),
      annotations: Transaction.userEvent.of("setValue"),
    });
  }

  echo() {
    const text = this._view?.state.doc.toString() ?? "";
    const label = document.createElement("div");
    label.className = "cell-input-label";
    label.innerHTML = this._promptHtml;
    const body = document.createElement("pre");
    body.className = "cell-input-body";
    if (this._highlightRanges.length > 0) {
      body.appendChild(applyRangesToText(text, this._highlightRanges));
    } else {
      body.textContent = text;
    }
    return html`<div class="cell-input">${label}${body}</div>`;
  }

  disable() {
    this._view?.dispatch({
      effects: this._readOnly.reconfigure(EditorState.readOnly.of(true)),
    });
  }

  enable() {
    this._view?.dispatch({
      effects: this._readOnly.reconfigure(EditorState.readOnly.of(false)),
    });
  }

  focus() { this._view?.focus(); }

  layout() { this._view?.requestMeasure(); }

  setPromptHtml(promptHtml) {
    this._promptHtml = promptHtml;
    this.labelEl.innerHTML = promptHtml;
  }

  selectSubstring(needle) {
    if (!this._view || !needle) return;
    const text = this._view.state.doc.toString();
    const idx = text.indexOf(needle);
    if (idx === -1) return;
    this._view.dispatch({
      selection: EditorSelection.range(idx, idx + needle.length),
    });
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
    const view = this._view;
    if (!view) return;
    const text = view.state.doc.toString();
    const pos = view.state.selection.main.head;

    const isFirstNav = this._navDraft === null;
    if (isFirstNav && direction === "prev") {
      this._navDraft = text;
    }

    let filter = null;
    const sel = view.state.selection.main;
    if (!sel.empty) {
      filter = view.state.doc.sliceString(sel.from, sel.to);
    } else if (isFirstNav) {
      const atEnd = pos === text.length;
      if (atEnd) filter = text || null;
    }

    const request_id = crypto.randomUUID();
    this._promptCollection._histNavRequests.set(request_id, this);
    this._promptCollection._buche.sendCommand({
      type: "history_navigate",
      to: this.address,
      direction,
      anchor_id: this._navAnchorId,
      text,
      position: pos,
      filter,
      tag: this.tag,
      request_id,
    });
  }
}

// ── PromptCollection ─────────────────────────────────────────────────────────

export class PromptCollection {
  constructor(container, buche, zoneName = "main") {
    this._buche = buche;
    this._zoneName = zoneName;
    this._prompts = [];
    this._activeIdx = 0;
    this._container = container;
    this.onFocus = null;
    this.onActiveChanged = null;
    this.onPromptsChanged = null;
    this.onActiveColorChanged = null;
    this.onActivePromptChanged = null;
    this.onPromptRemoved = null;
    this._parseRequests = new Map();
    this._completionRequests = new Map();
    this._histNavRequests = new Map();

    this._tabBar = document.createElement("div");
    this._tabBar.className = "prompt-tabs";
    container.insertAdjacentElement("afterend", this._tabBar);

    if (!_keysRegistered) {
      _keysRegistered = true;
      // Window-level bindings (add chord sequences etc. here)
      tinykeys(window, {});
    }
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
    p.init();
    this._activate(this._prompts.length - 1);
    requestAnimationFrame(() => p.focus());
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
    this.onActivePromptChanged?.(prev?.promptId ?? null, next.promptId);
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

  disable() { this._active?.disable(); }

  enable() {
    for (const p of this._prompts) p.enable();
  }

  focus() { this._active?.focus(); }

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
    if (toRemove.length > 0) {
      this.onPromptRemoved?.(toRemove.map(p => p.promptId));
    }
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
    if (!p?._view) return;
    p._view.dispatch({
      changes: { from: 0, to: p._view.state.doc.length, insert: text },
      selection: EditorSelection.cursor(
        position != null ? Math.min(position, text.length) : text.length,
      ),
    });
  }

  applyHighlight({ request_id, ranges, filigrane }) {
    const prompt = this._parseRequests.get(request_id);
    if (!prompt) return;
    this._parseRequests.delete(request_id);
    prompt.applyHighlight(ranges);
    prompt._filigrane = filigrane ?? null;
    prompt._updateGhostText();
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
    const view = prompt._view;
    if (!view) return;

    let insert;
    if (completions.length === 1) {
      insert = completions[0].value;
    } else {
      let common = completions[0].value;
      for (const { value } of completions) {
        while (!value.startsWith(common)) common = common.slice(0, -1);
      }
      if (common.length <= prefix.length) return;
      insert = common;
    }
    if (insert === prefix) return;

    view.dispatch({
      changes: { from: position - prefix.length, to: position, insert },
      selection: EditorSelection.cursor(position - prefix.length + insert.length),
    });
  }
}
