import { html } from "./utils.js";

export class InputPrompt {
  constructor(container, buche) {
    this._buche = buche;
    this._echoes = new Map();

    const vsBase = "file://" + buche.vsBase;

    window.MonacoEnvironment = {
      getWorkerUrl(_moduleId, _label) {
        return `data:text/javascript;charset=utf-8,${encodeURIComponent(`
          self.MonacoEnvironment = { baseUrl: '${vsBase}/' };
          importScripts('${vsBase}/base/worker/workerMain.js');
        `)}`;
      },
    };

    const loaderScript = document.createElement("script");
    loaderScript.src = vsBase + "/loader.js";
    loaderScript.onload = () => {
      require.config({ paths: { vs: vsBase } });
      require(["vs/editor/editor.main"], () => this._init(container));
    };
    document.head.appendChild(loaderScript);
  }

  onSubmit(value) {
    const cell_id = crypto.randomUUID();
    this._echoes.set(cell_id, this.echo());
    this._buche.sendCommand({ type: "parse", text: value, cell_id });
    this.onAfterSubmit(cell_id);
  }

  // Override from outside to hook into submit events.
  onAfterSubmit(_cell_id) {}

  disable() {
    this._editor?.updateOptions({ readOnly: true });
  }

  enable() {
    this._editor?.updateOptions({ readOnly: false });
  }

  takeEcho(cell_id) {
    const node = this._echoes.get(cell_id);
    this._echoes.delete(cell_id);
    return node;
  }

  _init(container) {
    this._editor = monaco.editor.create(container, {
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
      padding: { top: 4, bottom: 4 },
      lineHeight: 20,
      quickSuggestions: false,
      suggestOnTriggerCharacters: false,
      acceptSuggestionOnEnter: "off",
      tabCompletion: "off",
      wordBasedSuggestions: "off",
      parameterHints: { enabled: false },
      suggest: { showWords: false },
    });

    this._editor.focus();

    // Submit on Enter (Shift+Enter inserts a newline)
    this._editor.addCommand(monaco.KeyCode.Enter, () => {
      const value = this._editor.getValue().trim();
      if (!value) return;
      this.onSubmit(value);
      this._editor.setValue("");
    });
  }

  echo() {
    const text = this._editor?.getValue() ?? "";
    return html`<pre class="cell-input">&gt; ${text}</pre>`;
  }

  focus() {
    this._editor?.focus();
  }
}
