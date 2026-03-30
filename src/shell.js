const pty = require("node-pty");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const readline = require("node:readline");
const os = require("node:os");
const { sync: globSync } = require("glob");
const bashParser = require("bash-parser");

async function* merge(iterables) {
  const queue = [];
  let notify = null;
  let active = 0;
  let outerDone = false;

  function push(value) {
    queue.push(value);
    if (notify) {
      const r = notify;
      notify = null;
      r();
    }
  }

  async function pumpOuter() {
    for await (const iter of iterables) {
      active++;
      async function drain() {
        for await (const value of iter) {
          push({ value });
        }
        active--;
        push({ noop: true });
      }
      drain();
    }
    outerDone = true;
    push({ noop: true });
  }

  pumpOuter();

  while (true) {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item.noop) {
        yield item.value;
      }
    }
    if (outerDone && active === 0) {
      break;
    }
    await new Promise((r) => {
      notify = r;
    });
  }
}

function makeError(err, cell_id = null) {
  return {
    type: "error",
    error_type: err.code ?? err.constructor.name,
    message: err.message,
    traceback: err.stack
      ? err.stack
          .split("\n")
          .slice(1)
          .map((s) => s.trim())
      : [],
    cell_id,
  };
}

async function* withErrorCatch(iter, cell_id) {
  try {
    yield* iter;
  } catch (err) {
    yield makeError(err, cell_id);
  }
}

class FeatureNotImplementedError extends Error {
  constructor(feature) {
    super(`Feature not implemented: ${feature}`);
    this.code = "FeatureNotImplemented";
  }
}

class ProcessBuilder {
  constructor(shell) {
    this._shell = shell;
  }

  async *runNode(node, cell_id, echo) {
    switch (node.type) {
      case "Command":
        yield* this._runCommand(node, cell_id, echo);
        break;
      case "Pipeline":
        throw new FeatureNotImplementedError("pipes (|)");
      case "LogicalExpression":
        throw new FeatureNotImplementedError(
          `logical expressions (${node.op})`,
        );
      case "Subshell":
        throw new FeatureNotImplementedError("subshells (...)");
      case "For":
        throw new FeatureNotImplementedError("for loops");
      case "While":
        throw new FeatureNotImplementedError("while loops");
      case "Until":
        throw new FeatureNotImplementedError("until loops");
      case "If":
        throw new FeatureNotImplementedError("if statements");
      case "Case":
        throw new FeatureNotImplementedError("case statements");
      case "Function":
        throw new FeatureNotImplementedError("function definitions");
      default:
        throw new Error(`Unknown AST node type: ${node.type}`);
    }
  }

  async *_runCommand(node, cell_id, echo) {
    if (!node.name) {
      // Bare variable assignment — no process to run
      return;
    }

    const cmd = node.name.text;
    const args = [];

    for (const item of node.suffix || []) {
      if (item.type === "Redirect") {
        // TODO: handle redirections
        continue;
      }
      // Word — apply glob expansion if the text contains unquoted glob characters
      for (const expanded of this._expandWord(item.text)) {
        args.push(expanded);
      }
    }

    yield* this._shell.handle$run({ command: cmd, args, cell_id, echo });
  }

  _expandWord(text) {
    if (/[*?[]/.test(text)) {
      // Normalize **.ext to **/*.ext so ** expands across directory levels
      const pattern = text.replace(/\*\*(?!\/)/g, "**/*");
      const results = globSync(pattern, { cwd: process.cwd(), dot: false });
      if (results.length > 0) {
        return results;
      }
    }
    return [text];
  }
}

class Process {
  constructor(cmd, args, cell_id) {
    this._queue = [];
    this._resolve = null;
    this._done = false;

    // Open a PTY pair for each stream so the child's isatty() returns true,
    // while we still read stdout and stderr separately from the master sides.
    const stdinPty = pty.open({ cols: 220, rows: 50 });
    stdinPty._slave.destroy(); // prevent _slave from racing the child for stdin reads
    const stdoutPty = pty.open({ cols: 220, rows: 50 });
    const stderrPty = pty.open({ cols: 220, rows: 50 });
    const { O_RDWR, O_NOCTTY } = fs.constants;
    const stdinSlave = fs.openSync(stdinPty.ptsName, O_RDWR | O_NOCTTY);
    const stdoutSlave = fs.openSync(stdoutPty.ptsName, O_RDWR | O_NOCTTY);
    const stderrSlave = fs.openSync(stderrPty.ptsName, O_RDWR | O_NOCTTY);

    this._stdinPty = stdinPty;

    const emit = (event) => {
      this._queue.push(event);
      if (this._resolve) {
        const r = this._resolve;
        this._resolve = null;
        r();
      }
    };

    // Echo from stdin PTY master (respects ECHO flag set via tcsetattr)
    stdinPty._socket.on("data", (d) =>
      emit({ type: "send", cell_id, stream: "stdout", text: d.toString() }),
    );
    stdoutPty._socket.on("data", (d) =>
      emit({ type: "send", cell_id, stream: "stdout", text: d.toString() }),
    );
    stderrPty._socket.on("data", (d) =>
      emit({ type: "send", cell_id, stream: "stderr", text: d.toString() }),
    );
    // EIO means the slave side closed (process exited) — not a real error.
    stdinPty._socket.on("error", (e) => {
      if (e.code !== "EIO") {
        emit(makeError(e, cell_id));
      }
    });
    stdoutPty._socket.on("error", (e) => {
      if (e.code !== "EIO") {
        emit(makeError(e, cell_id));
      }
    });
    stderrPty._socket.on("error", (e) => {
      if (e.code !== "EIO") {
        emit(makeError(e, cell_id));
      }
    });

    const child = spawn(cmd, args, {
      stdio: [stdinSlave, stdoutSlave, stderrSlave, "pipe", "pipe"],
      env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
    });

    // Parent no longer needs the slave fds — child inherited them.
    fs.closeSync(stdinSlave);
    fs.closeSync(stdoutSlave);
    fs.closeSync(stderrSlave);

    this._datain = child.stdio[3];

    const DIRECTIVE_TYPES = new Set([
      "new",
      "send",
      "close",
      "new_prompt",
      "set_prompt",
      "error",
    ]);
    readline
      .createInterface({ input: child.stdio[4], crlfDelay: Infinity })
      .on("line", (line) => {
        let data;
        try {
          data = JSON.parse(line);
        } catch {
          return;
        }
        if (data.type && DIRECTIVE_TYPES.has(data.type)) {
          const transformed = { ...data };
          if (transformed.cell_id != null) {
            transformed.cell_id = `${cell_id}.${transformed.cell_id}`;
          }
          if (transformed.target_cell_id != null) {
            transformed.target_cell_id = `${cell_id}.${transformed.target_cell_id}`;
          }
          emit(transformed);
        } else {
          emit({ type: "send", cell_id, stream: "dataout", data });
        }
      });

    const cleanup = () => {
      stdinPty._socket.destroy();
      stdoutPty._socket.destroy();
      stderrPty._socket.destroy();
      child.stdio[3].destroy();
      child.stdio[4].destroy();
    };

    child.on("close", (return_code) => {
      cleanup();
      emit({ type: "close", cell_id, return_code: return_code ?? 0 });
      this._done = true;
    });
    child.on("error", (err) => {
      cleanup();
      emit(makeError(err, cell_id));
      emit({ type: "close", cell_id, return_code: 1 });
      this._done = true;
    });

    this.pid = child.pid;
    this._child = child;
  }

  writeStdin(text) {
    return new Promise((resolve, reject) =>
      fs.write(this._stdinPty._fd, text, (err) =>
        err ? reject(err) : resolve(),
      ),
    );
  }

  writeDatain(json) {
    return new Promise((resolve, reject) =>
      this._datain.write(`${JSON.stringify(json)}\n`, (err) =>
        err ? reject(err) : resolve(),
      ),
    );
  }

  closeStdin() {
    this._stdinPty._socket.destroy();
  }

  kill() {
    this._child.kill();
  }

  async *events() {
    while (true) {
      while (this._queue.length > 0) {
        yield this._queue.shift();
      }
      if (this._done) {
        break;
      }
      await new Promise((r) => {
        this._resolve = r;
      });
    }
  }
}

class Shell {
  constructor() {
    this._processes = new Map();
    this._vars = new Map(); // non-exported shell variables
    this._shutdown = false;
  }

  run(inputStream) {
    const self = this;
    async function* handlers() {
      yield (async function* prompt() {
        yield {
          type: "new_prompt",
          target_cell_id: null,
          side_html: "<span style='color:#569cd6;'>&gt;&gt;</span>",
          tab_html: "buche",
          language: "shell",
        };
      })();
      for await (const obj of inputStream) {
        if (obj.cell_id?.includes(".")) {
          const dot = obj.cell_id.indexOf(".");
          const proc = self._processes.get(obj.cell_id.slice(0, dot));
          if (proc) {
            proc.writeDatain({ ...obj, cell_id: obj.cell_id.slice(dot + 1) });
          }
          continue;
        }
        const handler = self[`handle$${obj.type}`];
        if (!handler) {
          continue;
        }
        try {
          const result = handler.call(self, obj);
          if (result[Symbol.asyncIterator]) {
            yield withErrorCatch(result, obj.cell_id ?? null);
          } else {
            await result;
          }
        } catch (err) {
          yield (async function* singleError() {
            yield makeError(err, obj.cell_id ?? null);
          })();
        }
        if (self._shutdown) {
          break;
        }
      }
    }
    return merge(handlers());
  }

  async handle$cd(obj) {
    process.chdir(obj.path);
  }

  async handle$set(obj) {
    if (obj.export) {
      process.env[obj.name] = obj.value;
      this._vars.delete(obj.name);
    } else {
      this._vars.set(obj.name, obj.value);
    }
  }

  async handle$wait(obj) {
    await new Promise((r) => setTimeout(r, obj.seconds * 1000));
  }

  async handle$input(obj) {
    const proc = this._processes.get(obj.cell_id);
    if (!proc) {
      return;
    }
    if (obj.data !== undefined) {
      await proc.writeDatain(obj.data);
    } else {
      await proc.writeStdin(obj.text);
    }
  }

  async handle$close_stdin(obj) {
    const proc = this._processes.get(obj.cell_id);
    if (proc) {
      proc.closeStdin();
    }
  }

  async handle$shutdown(_obj) {
    for (const proc of this._processes.values()) {
      proc.kill();
    }
    this._shutdown = true;
  }

  async *handle$run(obj) {
    if (obj.text !== undefined) {
      let ast;
      try {
        ast = bashParser(obj.text, {
          resolveEnv: (name) =>
            this._vars.get(name) ?? process.env[name] ?? "",
          resolveHomeUser: (username) => {
            if (!username) {
              return os.homedir();
            }
            return os.platform() === "darwin"
              ? `/Users/${username}`
              : `/home/${username}`;
          },
          resolveParameter: (param) =>
            this._vars.get(param.parameter) ??
            process.env[param.parameter] ??
            "",
        });
      } catch (err) {
        throw new Error(`Parse error: ${err.message}`);
      }
      const builder = new ProcessBuilder(this);
      let first = true;
      for (const node of ast.commands) {
        const cell_id = first ? (obj.cell_id ?? randomUUID()) : randomUUID();
        first = false;
        yield* builder.runNode(node, cell_id, obj.echo ?? true);
      }
      return;
    }

    const cell_id = obj.cell_id ?? randomUUID();
    if (this._processes.has(cell_id)) {
      throw new Error(`Process ${cell_id} already exists`);
    }

    const [cmd, ...args] = obj.parts ?? [obj.command, ...(obj.args || [])];
    const proc = new Process(cmd, args, cell_id);
    this._processes.set(cell_id, proc);

    yield {
      type: "new",
      cell_id,
      mode: "auto",
      echo: obj.echo,
      process_id: proc.pid,
    };

    for await (const event of proc.events()) {
      if (event.type === "close" && event.cell_id === cell_id) {
        this._processes.delete(cell_id);
      }
      yield event;
    }
  }
}

module.exports = { Shell };
