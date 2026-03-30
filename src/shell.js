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
      for (const item of node.prefix || []) {
        if (item.type === "AssignmentWord") {
          yield* this._shell.handle$run({
            command: "set",
            args: [item.text],
            cell_id,
            echo,
          });
        }
      }
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
            transformed.cell_id =
              transformed.cell_id === "parent"
                ? null
                : `${cell_id}.${transformed.cell_id}`;
          }
          if (transformed.target_cell_id != null) {
            transformed.target_cell_id =
              transformed.target_cell_id === "parent"
                ? null
                : `${cell_id}.${transformed.target_cell_id}`;
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

const BUILTINS = {
  async *cd(args, _cell_id) {
    yield { $command: { type: "cd", path: args[0] ?? os.homedir() } };
  },
  async *set(args, _cell_id) {
    for (const arg of args) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        yield {
          $command: {
            type: "set",
            name: arg.slice(0, eq),
            value: arg.slice(eq + 1),
            export: false,
          },
        };
      }
    }
  },
  async *export(args, _cell_id) {
    for (const arg of args) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        yield {
          $command: {
            type: "set",
            name: arg.slice(0, eq),
            value: arg.slice(eq + 1),
            export: true,
          },
        };
      }
    }
  },
  async *control(args, _cell_id) {
    const [subcommand, name, ...rest] = args;
    if (subcommand === "set") {
      let restartMs = null;
      let cmdArgs = rest;
      if (rest[0]?.startsWith("-t")) {
        restartMs = parseInt(rest[0].slice(2), 10);
        cmdArgs = rest.slice(1);
      }
      const [cmd, ...procArgs] = cmdArgs;
      yield {
        $command: { type: "control_set", name, cmd, args: procArgs, restartMs },
      };
    } else if (subcommand === "enable") {
      yield { $command: { type: "control_enable", name } };
    } else if (subcommand === "disable") {
      yield { $command: { type: "control_disable", name } };
    }
  },
};

class Shell {
  constructor() {
    this._processes = new Map();
    this._controls = new Map();
    this._vars = new Map(); // non-exported shell variables
    this._shutdown = false;
    this._builtins = BUILTINS;
    this._emitControlEvent = () => {};
  }

  run(inputStream) {
    const self = this;

    const controlQueue = [];
    let controlNotify = null;
    let controlDone = false;

    self._emitControlEvent = function (event) {
      controlQueue.push(event);
      if (controlNotify) {
        const r = controlNotify;
        controlNotify = null;
        r();
      }
    };

    async function* controlEvents() {
      while (true) {
        while (controlQueue.length > 0) {
          yield controlQueue.shift();
        }
        if (controlDone) {
          break;
        }
        await new Promise((r) => {
          controlNotify = r;
        });
      }
    }

    for (const [name, control] of self._controls) {
      if (control.enabled) {
        self._runControlLoop(name);
      }
    }

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
      controlDone = true;
      if (controlNotify) {
        const r = controlNotify;
        controlNotify = null;
        r();
      }
    }

    async function* allStreams() {
      yield controlEvents();
      yield* handlers();
    }

    return merge(allStreams());
  }

  _notifyControls(event) {
    for (const control of this._controls.values()) {
      control._proc?.writeDatain(event);
    }
  }

  async handle$cd(obj) {
    process.chdir(obj.path);
    this._notifyControls({ type: "cwd_changed", cwd: process.cwd() });
  }

  async handle$set(obj) {
    if (obj.export) {
      process.env[obj.name] = obj.value;
      this._vars.delete(obj.name);
      this._notifyControls({
        type: "env_changed",
        name: obj.name,
        value: obj.value,
      });
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
    for (const control of this._controls.values()) {
      control.enabled = false;
      control._proc?.kill();
    }
    this._shutdown = true;
  }

  handle$control_set(obj) {
    const control = {
      cmd: obj.cmd,
      args: obj.args ?? [],
      restartMs: obj.restartMs ?? null,
      enabled: true,
      _proc: null,
    };
    this._controls.set(obj.name, control);
    this._runControlLoop(obj.name);
  }

  handle$control_enable(obj) {
    const control = this._controls.get(obj.name);
    if (control && !control.enabled) {
      control.enabled = true;
      this._runControlLoop(obj.name);
    }
  }

  handle$control_disable(obj) {
    const control = this._controls.get(obj.name);
    if (control) {
      control.enabled = false;
      control._proc?.kill();
    }
  }

  async _runControlLoop(name) {
    const control = this._controls.get(name);
    while (control.enabled) {
      const cellId = `control.${name}`;
      const proc = new Process(control.cmd, control.args, cellId);
      control._proc = proc;
      for await (const event of proc.events()) {
        if (
          event.type === "send" &&
          event.stream === "dataout" &&
          event.data.$command != null
        ) {
          for await (const result of this._dispatchCommand(
            event.data.$command,
          )) {
            this._emitControlEvent(result);
          }
        } else {
          this._emitControlEvent(event);
        }
      }
      control._proc = null;
      if (control.restartMs == null || !control.enabled) {
        break;
      }
      await new Promise((r) => setTimeout(r, control.restartMs));
    }
  }

  async *handle$run(obj) {
    this._notifyControls({
      type: "command_run",
      text: obj.text,
      command: obj.command,
      args: obj.args,
      parts: obj.parts,
      cell_id: obj.cell_id,
    });
    if (obj.text !== undefined) {
      let ast;
      try {
        ast = bashParser(obj.text, {
          resolveEnv: (name) => this._vars.get(name) ?? process.env[name] ?? "",
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
    const [cmd, ...args] = obj.parts ?? [obj.command, ...(obj.args || [])];

    if (cmd in this._builtins) {
      yield { type: "new", cell_id, mode: "auto", echo: obj.echo };
      let return_code = 0;
      try {
        yield* this._runBuiltin(cmd, args, cell_id);
      } catch (err) {
        yield makeError(err, cell_id);
        return_code = 1;
      }
      yield { type: "close", cell_id, return_code };
      return;
    }

    if (this._processes.has(cell_id)) {
      throw new Error(`Process ${cell_id} already exists`);
    }

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
      if (
        event.type === "send" &&
        event.stream === "dataout" &&
        event.data.$command != null
      ) {
        yield* this._dispatchCommand(event.data.$command);
      } else {
        yield event;
      }
    }
  }

  async *_runBuiltin(name, args, cell_id) {
    for await (const item of this._builtins[name](args, cell_id)) {
      if (item.$command != null) {
        yield* this._dispatchCommand(item.$command);
      } else {
        yield item;
      }
    }
  }

  async *_dispatchCommand(obj) {
    const handler = this[`handle$${obj.type}`];
    if (!handler) {
      return;
    }
    const result = handler.call(this, obj);
    if (result && result[Symbol.asyncIterator]) {
      yield* withErrorCatch(result, obj.cell_id ?? null);
    } else {
      await result;
    }
  }
}

module.exports = { Shell };
