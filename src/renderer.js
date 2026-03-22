import { html } from './utils.js';
import { TextHandler } from './cell/text.js';
import './scroll-fader.js';

const vsBase = 'file://' + window.buche.vsBase;

// Tell Monaco where to load its web workers from
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

  require(['vs/editor/editor.main'], () => {
    window.editor = monaco.editor.create(document.getElementById('monaco-editor'), {
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

    window.editor.focus();

    // Submit on Enter (Shift+Enter inserts a newline)
    window.editor.addCommand(
      monaco.KeyCode.Enter,
      () => {
        const value = window.editor.getValue().trim();
        if (!value) return;
        window.buche.sendCommand({ type: 'parse', text: value, cell_id: crypto.randomUUID() });
        window.editor.setValue('');
      }
    );
  });
};
document.head.appendChild(loaderScript);

// ── Buffer protocol ─────────────────────────────────────────────────────

const bufferWrap = document.getElementById('buffer-wrap');
const buffer     = document.createElement('div');
buffer.id = 'buffer-inner';
bufferWrap.inner.appendChild(buffer);

const cellHandlers = { text: TextHandler };

class Executor {
  constructor() {
    this.cells = new Map();
  }

  execute(instruction) {
    const handler = this[`handle$${instruction.type}`];
    if (handler) handler.call(this, instruction);
  }

  handle$new(instruction) {
    if (this.cells.has(instruction.cell_id)) {
      console.error('Cell already exists:', instruction.cell_id);
      return;
    }
    const HandlerClass = cellHandlers[instruction.mode];
    if (!HandlerClass) {
      console.error('Unknown mode:', instruction.mode);
      return;
    }
    const cellNode = html`<div class="cell" data-cell-id="${instruction.cell_id}"></div>`;
    buffer.appendChild(cellNode);

    const handler = new HandlerClass(cellNode, instruction);
    handler.init();
    this.cells.set(instruction.cell_id, handler);
  }

  handle$send(instruction) {
    const handler = this.cells.get(instruction.cell_id);
    if (!handler) return;
    handler.send(instruction.data);
  }

  handle$close(instruction) {
    this.cells.delete(instruction.cell_id);
  }
}

const executor = new Executor();
window.buche.onInstruction(instruction => executor.execute(instruction));
