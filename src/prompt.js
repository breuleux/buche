export class InputPrompt {
  constructor(containerId, buche) {
    this._buche = buche;

    const vsBase = 'file://' + buche.vsBase;

    window.MonacoEnvironment = {
      getWorkerUrl(_moduleId, _label) {
        return `data:text/javascript;charset=utf-8,${encodeURIComponent(`
          self.MonacoEnvironment = { baseUrl: '${vsBase}/' };
          importScripts('${vsBase}/base/worker/workerMain.js');
        `)}`;
      }
    };

    const loaderScript = document.createElement('script');
    loaderScript.src = vsBase + '/loader.js';
    loaderScript.onload = () => {
      require.config({ paths: { vs: vsBase } });
      require(['vs/editor/editor.main'], () => this._init(containerId));
    };
    document.head.appendChild(loaderScript);
  }

  onSubmit(value) {
    this._buche.sendCommand({ type: 'parse', text: value, cell_id: crypto.randomUUID() });
  }

  _init(containerId) {
    this._editor = monaco.editor.create(document.getElementById(containerId), {
      value: '',
      language: 'plaintext',
      theme: 'vs-dark',
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      lineNumbers: 'off',
      renderLineHighlight: 'none',
      overviewRulerLanes: 0,
      folding: false,
      wordWrap: 'on',
      fontSize: 13,
      fontFamily: 'Consolas, Menlo, monospace',
      padding: { top: 4, bottom: 4 },
      lineHeight: 20,
      quickSuggestions: false,
      suggestOnTriggerCharacters: false,
      acceptSuggestionOnEnter: 'off',
      tabCompletion: 'off',
      wordBasedSuggestions: 'off',
      parameterHints: { enabled: false },
      suggest: { showWords: false },
    });

    this._editor.focus();

    // Submit on Enter (Shift+Enter inserts a newline)
    this._editor.addCommand(monaco.KeyCode.Enter, () => {
      const value = this._editor.getValue().trim();
      if (!value) return;
      this.onSubmit(value);
      this._editor.setValue('');
    });
  }

  focus() {
    this._editor?.focus();
  }
}
