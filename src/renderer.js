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
    });

    // Submit on Enter (Shift+Enter inserts a newline)
    window.editor.addCommand(
      monaco.KeyCode.Enter,
      () => {
        const value = window.editor.getValue().trim();
        if (!value) return;
        console.log('command:', value);
        window.editor.setValue('');
      }
    );
  });
};
document.head.appendChild(loaderScript);

// ── Buffer protocol ─────────────────────────────────────────────────────

const bufferWrap = document.getElementById('buffer-wrap');
const bufferEl   = document.getElementById('buffer');
const buffer     = document.getElementById('buffer-inner');
const cells      = new Map(); // cell_id -> handler

// Both scroll containers use column-reverse: scrollTop=0 = physical bottom (newest content).
function makeShadows(parent, height) {
  const top = document.createElement('div');
  top.className = 'scroll-shadow scroll-shadow-top';
  top.style.height = height + 'px';
  const bottom = document.createElement('div');
  bottom.className = 'scroll-shadow scroll-shadow-bottom';
  bottom.style.height = height + 'px';
  parent.appendChild(top);
  parent.appendChild(bottom);
  return { top, bottom };
}

function updateScrollFades(scrollEl, shadows) {
  const { scrollTop, scrollHeight, clientHeight } = scrollEl;
  const maxScroll = scrollHeight - clientHeight;
  // column-reverse: scrollTop is 0 at visual bottom (newest), goes negative scrolling up
  const scrolled  = Math.abs(scrollTop);
  const atBottom  = scrolled <= 2;
  const atTop     = maxScroll <= 2 || scrolled >= maxScroll - 4;
  shadows.top.classList.toggle('visible',    !atTop);
  shadows.bottom.classList.toggle('visible', !atBottom);
}

const bufferShadows = makeShadows(bufferWrap, 48);
bufferEl.addEventListener('scroll', () => updateScrollFades(bufferEl, bufferShadows));

class TextHandler {
  constructor(cellNode, instruction) {
    this.cellNode    = cellNode;
    this.instruction = instruction;
    this.wrapper     = null; // .cell-text  — overlay host
    this.scrollEl    = null; // .cell-text-scroll — scroll container
    this.pre         = null; // .cell-text-inner  — content
  }

  init() {
    if (this.instruction.data) {
      const header = document.createElement('pre');
      header.className = 'cell-input';
      header.textContent = this.instruction.data.text;
      this.cellNode.appendChild(header);
    }

    this.wrapper = document.createElement('div');
    this.wrapper.className = 'cell-text';
    this.cellNode.appendChild(this.wrapper);

    this.scrollEl = document.createElement('div');
    this.scrollEl.className = 'cell-text-scroll';
    this.wrapper.appendChild(this.scrollEl);

    this.pre = document.createElement('pre');
    this.pre.className = 'cell-text-inner';
    this.scrollEl.appendChild(this.pre);

    this.shadows = makeShadows(this.wrapper, 32);
    this.scrollEl.addEventListener('scroll',
      () => updateScrollFades(this.scrollEl, this.shadows));
    updateScrollFades(this.scrollEl, this.shadows);
  }

  send(data) {
    const span = document.createElement('span');
    span.className = 'text-' + (data.stream || 'stdout');
    span.textContent = data.text;
    this.pre.appendChild(span);
    updateScrollFades(this.scrollEl, this.shadows);
    updateScrollFades(bufferEl, bufferShadows);
  }
}

const handlers = { text: TextHandler };

function executeInstruction(instruction) {
  if (instruction.command === 'new') {
    if (cells.has(instruction.cell_id)) {
      console.error('Cell already exists:', instruction.cell_id);
      return;
    }
    const cellNode = document.createElement('div');
    cellNode.className = 'cell';
    cellNode.dataset.cellId = instruction.cell_id;
    buffer.appendChild(cellNode);
    updateScrollFades(bufferEl, bufferShadows);

    const HandlerClass = handlers[instruction.mode];
    if (!HandlerClass) {
      console.error('Unknown mode:', instruction.mode);
      return;
    }
    const handler = new HandlerClass(cellNode, instruction);
    handler.init();
    cells.set(instruction.cell_id, handler);

  } else if (instruction.command === 'send') {
    const handler = cells.get(instruction.cell_id);
    if (!handler) {
      // TODO: handle send to expired/missing cell
      return;
    }
    handler.send(instruction.data);
  }
}

window.buche.onInstruction(executeInstruction);
