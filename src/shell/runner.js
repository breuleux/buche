const pty = require("node-pty");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const readline = require("node:readline");
const os = require("node:os");
const path = require("node:path");
const { sync: globSync } = require("glob");
const bashParser = require("bash-parser");
const { loadConfig } = require("./config");

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
  constructor(cmd, args, cell_id, cols) {
    this._queue = [];
    this._resolve = null;
    this._done = false;

    // Open a PTY pair for each stream so the child's isatty() returns true,
    // while we still read stdout and stderr separately from the master sides.
    const stdinPty = pty.open({ cols, rows: 50 });
    stdinPty._slave.destroy(); // prevent _slave from racing the child for stdin reads
    const stdoutPty = pty.open({ cols, rows: 50 });
    const stderrPty = pty.open({ cols, rows: 50 });
    const { O_RDWR, O_NOCTTY } = fs.constants;
    const stdinSlave = fs.openSync(stdinPty.ptsName, O_RDWR | O_NOCTTY);
    const stdoutSlave = fs.openSync(stdoutPty.ptsName, O_RDWR | O_NOCTTY);
    const stderrSlave = fs.openSync(stderrPty.ptsName, O_RDWR | O_NOCTTY);

    this._stdinPty = stdinPty;
    this._stdoutPty = stdoutPty;
    this._stderrPty = stderrPty;

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

  resize(cols) {
    pty.native.resize(this._stdinPty._fd, cols, 50);
    pty.native.resize(this._stdoutPty._fd, cols, 50);
    pty.native.resize(this._stderrPty._fd, cols, 50);
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

function cmdExists(cmd, builtins) {
  if (cmd in builtins) {
    return true;
  }
  if (path.isAbsolute(cmd)) {
    return fs.existsSync(cmd);
  }
  const dirs = (process.env.PATH || "").split(":").filter(Boolean);
  return dirs.some((dir) => fs.existsSync(path.join(dir, cmd)));
}

function fsPathExists(arg) {
  if (!arg || arg.startsWith("-")) {
    return false;
  }
  const expanded = arg.startsWith("~")
    ? path.join(os.homedir(), arg.slice(1))
    : arg;
  return fs.existsSync(path.resolve(process.cwd(), expanded));
}

function shellHighlight(text, builtins) {
  // Tokenize: quoted strings, variable expansions, operators, words
  const tokenRe =
    /('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|\$\{[^}]*\}|\$\([^)]*\)|\$[A-Za-z_][A-Za-z0-9_]*|&&|\|\||>>|2>|[|;&<>]|\S+)/g;
  const ranges = [];
  let state = "cmd"; // "cmd" | "arg" | "redir-target"
  let match;

  while ((match = tokenRe.exec(text)) !== null) {
    const token = match[0];
    const start = match.index;
    const end = start + token.length;

    if (state === "redir-target") {
      ranges.push({ start, end, cls: "sh-arg" });
      state = "arg";
      continue;
    }

    if (
      token === "&&" ||
      token === "||" ||
      token === "|" ||
      token === ";" ||
      token === "&"
    ) {
      ranges.push({ start, end, cls: "sh-op" });
      state = "cmd";
    } else if (
      token === ">" ||
      token === "<" ||
      token === ">>" ||
      token === "2>"
    ) {
      ranges.push({ start, end, cls: "sh-redirect" });
      state = "redir-target";
    } else if (token.startsWith("'") || token.startsWith('"')) {
      ranges.push({ start, end, cls: "sh-string" });
      if (state === "cmd") {
        state = "arg";
      }
    } else if (token.startsWith("$(")) {
      ranges.push({ start, end, cls: "sh-subshell" });
      state = "arg";
    } else if (token.startsWith("$")) {
      ranges.push({ start, end, cls: "sh-var" });
    } else if (state === "cmd") {
      ranges.push({ start, end, cls: "sh-cmd" });
      state = "arg";
    } else if (token.startsWith("-")) {
      ranges.push({ start, end, cls: "sh-flag" });
    } else {
      ranges.push({ start, end, cls: "sh-arg" });
    }

    // Overlapping: variable refs inside double-quoted strings and plain words
    const scanInner = token.startsWith('"')
      ? token.slice(1, -1)
      : !token.startsWith("'") && !token.startsWith("$")
        ? token
        : null;
    if (scanInner) {
      const offset = token.startsWith('"') ? 1 : 0;
      const varRe = /\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*/g;
      let vm;
      while ((vm = varRe.exec(scanInner)) !== null) {
        ranges.push({
          start: start + offset + vm.index,
          end: start + offset + vm.index + vm[0].length,
          cls: "sh-var",
        });
      }
    }
  }

  for (const { start, end, cls } of [...ranges]) {
    const token = text.slice(start, end);
    if (cls === "sh-cmd" && !cmdExists(token, builtins)) {
      ranges.push({ start, end, cls: "sh-invalid" });
    } else if (cls === "sh-arg" && fsPathExists(token)) {
      ranges.push({ start, end, cls: "sh-path" });
    }
  }

  return ranges;
}

async function shellComplete(text, position, builtins) {
  const left = text.slice(0, position);
  const prefix = /(\S*)$/.exec(left)?.[1] ?? "";
  const beforePrefix = left.slice(0, left.length - prefix.length);
  const isCommandPos = /(?:^|[|&;])\s*$/.test(beforePrefix);

  if (isCommandPos) {
    const completions = [];
    for (const name of Object.keys(builtins)) {
      if (name.startsWith(prefix)) {
        completions.push({ value: name, kind: "builtin" });
      }
    }
    const seen = new Set(completions.map((c) => c.value));
    const pathDirs = (process.env.PATH || "").split(":").filter(Boolean);
    const perDir = await Promise.all(
      pathDirs.map(async (dir) => {
        try {
          return await fs.promises.readdir(dir);
        } catch {
          return [];
        }
      }),
    );
    for (const files of perDir) {
      for (const f of files) {
        if (f.startsWith(prefix) && !seen.has(f)) {
          completions.push({ value: f, kind: "executable" });
          seen.add(f);
        }
      }
    }
    completions.sort((a, b) => {
      if (a.kind !== b.kind) {
        return a.kind === "builtin" ? -1 : 1;
      }
      return a.value.localeCompare(b.value);
    });
    return completions;
  }

  // File/directory completions
  const results = globSync((prefix || "") + "*", {
    cwd: process.cwd(),
    dot: prefix.startsWith("."),
    mark: true,
  });
  results.sort((a, b) => {
    if (a.endsWith("/") !== b.endsWith("/")) {
      return a.endsWith("/") ? -1 : 1;
    }
    return a.localeCompare(b);
  });
  return results.map((value) => ({
    value,
    kind: value.endsWith("/") ? "directory" : "file",
  }));
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
    this._cols = 230;
  }

  run(inputStream) {
    const self = this;

    const controlQueue = [];
    let controlNotify = null;
    let controlDone = false;

    self._emitControlEvent = (event) => {
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
      yield (async function* init() {
        yield* self._applyConfig();
        yield {
          type: "new_prompt",
          target_cell_id: null,
          side_html: "<span style='color:#569cd6;'>&gt;&gt;</span>",
          tab_html: "buche",
          // language: "shell",
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
          if (result && result[Symbol.asyncIterator]) {
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

  async *_applyConfig() {
    const { env, control, interface: iface } = loadConfig(process.cwd());

    // Apply env vars
    for (const [name, { value, export: isExport }] of env) {
      if (isExport) {
        process.env[name] = value;
        this._vars.delete(name);
      } else {
        this._vars.set(name, value);
      }
      this._notifyControls({ type: "env_changed", name, value });
    }

    // Reconcile control processes: terminate those that disappeared or changed,
    // start those that are new. Leave unchanged entries alone.
    for (const [name, ctrl] of this._controls) {
      const desired = control.get(name);
      const same =
        desired &&
        desired.cmd === ctrl.cmd &&
        desired.args.join("\0") === ctrl.args.join("\0");
      if (!same) {
        ctrl.enabled = false;
        ctrl._proc?.kill();
        this._controls.delete(name);
      }
    }
    for (const [name, { cmd, args }] of control) {
      if (!this._controls.has(name)) {
        const ctrl = { cmd, args, restartMs: null, enabled: true, _proc: null };
        this._controls.set(name, ctrl);
        this._runControlLoop(name);
      }
    }

    yield { type: "configure", interface: iface ?? {} };
  }

  async *handle$cd(obj) {
    process.chdir(obj.path);
    this._notifyControls({ type: "cwd_changed", cwd: process.cwd() });
    yield* this._applyConfig();
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

  async *handle$parse(obj) {
    const { text, position, want_completions, request_id } = obj;
    yield {
      type: "highlight",
      request_id,
      ranges: shellHighlight(text, this._builtins),
    };
    if (want_completions) {
      const completions = await shellComplete(text, position, this._builtins);
      yield { type: "complete", request_id, completions };
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

  handle$resize(obj) {
    this._cols = obj.cols;
    for (const proc of this._processes.values()) {
      proc.resize(obj.cols);
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
      const proc = new Process(control.cmd, control.args, cellId, this._cols);
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

    const proc = new Process(cmd, args, cell_id, this._cols);
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
