const pty = require("node-pty");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const readline = require("node:readline");
const os = require("node:os");
const path = require("node:path");
const { sync: globSync } = require("glob");
const bashParser = require("bash-parser");
const { BUILTINS } = require("./builtins");
const { loadConfig } = require("./config");

function expandEnvVars(str, env) {
  return str.replace(
    /\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (_, braced, bare) => env[braced ?? bare] ?? "",
  );
}

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

function makeError(err) {
  return {
    type: "error",
    to: { target: "terminal" },
    error_type: err.code ?? err.constructor.name,
    message: err.message,
    traceback: err.stack
      ? err.stack
          .split("\n")
          .slice(1)
          .map((s) => s.trim())
      : [],
  };
}

async function* withErrorCatch(iter) {
  try {
    yield* iter;
  } catch (err) {
    yield makeError(err);
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

  async *runNode(node, echo_html, prompt_name, background = false, zone = "main") {
    switch (node.type) {
      case "Command":
        yield* this._runCommand(node, echo_html, prompt_name, background, zone);
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

  async *_runCommand(node, echo_html, prompt_name, background = false, zone = "main") {
    if (!node.name) {
      for (const item of node.prefix || []) {
        if (item.type === "AssignmentWord") {
          yield* this._shell.handle$prompt_submit({
            command: "set",
            args: [item.text],
            zone,
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

    yield* this._shell.handle$prompt_submit({
      command: cmd,
      args,
      echo_html,
      prompt_name,
      background,
      zone,
    });
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
  constructor(cmd, args, processId, cols, extraEnv = {}, cwd = undefined) {
    this._queue = [];
    this._resolve = null;
    this._done = false;

    // Single PTY for stdin/stdout/stderr — this is how real terminals work.
    // Programs like less/more/emacs open /dev/tty for both keyboard input and
    // display output; with a single PTY they all resolve to the same device,
    // so there is no split between multiple masters.
    const mainPty = pty.open({ cols, rows: 24 });
    mainPty._slave.destroy(); // close parent's internal slave fd; child gets its own via slaveFd below
    const { O_RDWR, O_NOCTTY } = fs.constants;
    // Open the slave once; spawn will dup it to fd 0, 1, and 2 in the child.
    const slaveFd = fs.openSync(mainPty.ptsName, O_RDWR | O_NOCTTY);

    this._pty = mainPty;

    const helperPath = path.join(__dirname, "buche-exec");
    const child = spawn("python3", [helperPath, cmd, ...args], {
      stdio: [slaveFd, slaveFd, slaveFd, "pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        BUCHE_CONTROL_FD: "5",
        ...extraEnv,
      },
      ...(cwd !== undefined && { cwd }),
    });

    // Parent no longer needs the slave fd — child inherited it.
    fs.closeSync(slaveFd);

    this.pid = child.pid;
    this.processId = processId;
    this._datain = child.stdio[3];
    this._control = child.stdio[5];
    this._child = child;

    const emit = (event) => {
      this._queue.push(event);
      if (this._resolve) {
        const r = this._resolve;
        this._resolve = null;
        r();
      }
    };

    const cellTo = { target: "terminal", cell: "main" };
    const cellAddress = { process: processId };
    mainPty._socket.on("data", (d) =>
      emit({
        type: "send",
        to: cellTo,
        address: cellAddress,
        stream: "stdout",
        text: d.toString(),
      }),
    );
    // EIO means the slave side closed (process exited) — not a real error.
    mainPty._socket.on("error", (e) => {
      if (e.code !== "EIO") emit(makeError(e));
    });

    // fd5: control channel (full duplex) — directives from child to shell
    const rl5 = readline
      .createInterface({ input: child.stdio[5], crlfDelay: Infinity })
      .on("line", (line) => {
        let data;
        try {
          data = JSON.parse(line);
        } catch {
          return;
        }
        const transformed = { ...data };
        // Wrap address: subprocess's address (defaulting to {}) becomes {process: processId, subaddress: orig}
        if (transformed.address?.parent) {
          transformed.address = { target: "shell" };
        } else if (transformed.address) {
          transformed.address = {
            process: processId,
            subaddress: transformed.address ?? {},
          };
        } else {
          transformed.address = { process: processId };
        }
        // Wrap to.process: subprocess's child routing gets prefixed with this process
        if (transformed.to?.process !== undefined) {
          transformed.to = { process: processId, subaddress: transformed.to };
        } else if (!transformed.to) {
          transformed.to = { target: "terminal" };
        }
        // Namespace process_close.process_id so it can't collide with the
        // parent shell's process IDs (both start their counters from 0).
        if (transformed.type === "process_close") {
          transformed.process_id = `${processId}/${transformed.process_id}`;
        }
        emit(transformed);
      });

    // fd4: data channel — arbitrary JSON objects sent to the renderer
    const rl4 = readline
      .createInterface({ input: child.stdio[4], crlfDelay: Infinity })
      .on("line", (line) => {
        let data;
        try {
          data = JSON.parse(line);
        } catch {
          return;
        }
        emit({
          type: "send",
          to: cellTo,
          address: cellAddress,
          stream: "dataout",
          data,
        });
      });

    const cleanup = () => {
      rl4.close();
      rl5.close();
      mainPty._socket.destroy();
      child.stdio[3].destroy();
      child.stdio[4].destroy();
      child.stdio[5].destroy();
    };

    child.on("close", (return_code) => {
      cleanup();
      emit({
        type: "process_close",
        to: { target: "terminal" },
        process_id: processId,
        return_code: return_code ?? 0,
      });
      this._done = true;
    });
    child.on("error", (err) => {
      cleanup();
      emit(makeError(err));
      emit({
        type: "process_close",
        to: { target: "terminal" },
        process_id: processId,
        return_code: 1,
      });
      this._done = true;
    });
  }

  resize(cols, rows = 24) {
    pty.native.resize(this._pty._fd, cols, rows);
  }

  writeStdin(text) {
    return new Promise((resolve, reject) =>
      fs.write(this._pty._fd, text, (err) =>
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

  writeControl(json) {
    return new Promise((resolve, reject) =>
      this._control.write(`${JSON.stringify(json)}\n`, (err) =>
        err ? reject(err) : resolve(),
      ),
    );
  }

  close() {
    this._pty._socket.destroy();
    this._datain.destroy();
    this._control.destroy();
  }

  kill(signal) {
    this._child.kill(signal);
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

function isExecutable(filePath) {
  try {
    return (
      fs.statSync(filePath).isFile() &&
      (fs.accessSync(filePath, fs.constants.X_OK), true)
    );
  } catch {
    return false;
  }
}

function cmdExists(cmd, builtins) {
  if (cmd in builtins) {
    return true;
  }
  if (cmd.includes("/")) {
    const resolved = path.isAbsolute(cmd)
      ? cmd
      : path.resolve(process.cwd(), cmd);
    return isExecutable(resolved);
  }
  const dirs = (process.env.PATH || "").split(":").filter(Boolean);
  return dirs.some((dir) => isExecutable(path.join(dir, cmd)));
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
    } else if (state === "cmd" && /^@(left|right|tab|float)$/.test(token)) {
      ranges.push({ start, end, cls: "sh-zone" });
      // state stays "cmd" so the following token is highlighted as the command
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

class Shell {
  constructor() {
    this._processes = new Map();
    this._controls = new Map();
    this._vars = new Map(); // non-exported shell variables
    this._shutdown = false;
    this._builtins = BUILTINS;
    this._emitControlEvent = () => {};
    this._cols = 230;
    this._nextProcessId = 0;
    this._keyBindings = new Map(); // binding name → command string
    this._promptBindings = {};     // key string → binding name (for prompt_create)
  }

  _generateProcessId() {
    return String(++this._nextProcessId);
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
          type: "prompt_create",
          to: { target: "terminal", prompt: "cq" },
          address: { target: "shell" },
          prompt: "<span style='color:#569cd6;'>&gt;&gt;</span>",
          name: "cq",
          tag: "cq",
          language: null,
          zone: "main",
          bindings: self._promptBindings,
        };
        // yield {
        //   type: "set_prompt",
        //   prompt: "<span style='color:#ff0000;'>!!</span>",
        //   to: { target: "terminal", prompt: "cq" },
        // };
      })();
      for await (const obj of inputStream) {
        // Route to subprocess via to.process
        if (obj.to?.process !== undefined) {
          const proc = self._processes.get(obj.to.process);
          if (proc) {
            const hasSubaddress = obj.to.subaddress !== undefined;
            if (obj.type === "input" && !hasSubaddress) {
              if (obj.data !== undefined) proc.writeDatain(obj.data);
              else proc.writeStdin(obj.text);
            } else if (obj.type === "close" && !hasSubaddress) {
              proc.close();
            } else if (obj.type === "kill" && !hasSubaddress) {
              proc.kill(obj.signal);
            } else {
              proc.writeControl({ ...obj, to: obj.to.subaddress ?? {} });
            }
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
            yield withErrorCatch(result);
          } else {
            await result;
          }
        } catch (err) {
          yield (async function* singleError() {
            yield makeError(err);
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

    async function* routed() {
      for await (const instruction of merge(allStreams())) {
        if (instruction.to?.target === "shell") {
          self._handleShellInstruction(instruction);
        } else {
          yield instruction;
        }
      }
    }

    return routed();
  }

  _handleShellInstruction(_instruction) {
    // nothing for now
  }

  _notifyControls(event) {
    const msg = { to: { target: "shell" }, ...event };
    for (const control of this._controls.values()) {
      control._proc?.writeControl(msg);
    }
  }

  async *_applyConfig() {
    const { env, control, interface: iface, bindings } = loadConfig(process.cwd());

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
        desired.args.join("\0") === ctrl.args.join("\0") &&
        desired.configDir === ctrl.configDir;
      if (!same) {
        ctrl.enabled = false;
        ctrl._proc?.kill();
        this._controls.delete(name);
      }
    }
    for (const [name, { cmd, args, configDir }] of control) {
      if (!this._controls.has(name)) {
        const ctrl = {
          cmd,
          args,
          configDir,
          restartMs: null,
          enabled: true,
          _proc: null,
        };
        this._controls.set(name, ctrl);
        this._runControlLoop(name);
      }
    }

    // Rebuild key bindings: assign stable names (UUIDs) to each key→command entry.
    this._keyBindings.clear();
    this._promptBindings = {};
    for (const [key, cmd] of bindings) {
      const name = crypto.randomUUID();
      this._keyBindings.set(name, cmd);
      this._promptBindings[key] = name;
    }

    yield {
      type: "configure",
      to: { target: "shell" },
      interface: iface ?? {},
    };
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
      to: { target: "terminal" },
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

  handle$resize(obj) {
    this._cols = obj.cols;
    for (const proc of this._processes.values()) {
      proc.resize(obj.cols);
    }
  }

  handle$pty_resize(obj) {
    const proc = this._processes.get(obj.to.process);
    proc?.resize(obj.cols, obj.rows);
  }

  handle$nuke(_obj) {
    for (const proc of this._processes.values()) {
      proc.kill();
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
      const processId = this._generateProcessId();
      const extraEnv = { THIS_CONFIG_DIR: control.configDir };
      const spawnEnv = { ...process.env, ...extraEnv };
      const proc = new Process(
        expandEnvVars(control.cmd, spawnEnv),
        control.args.map((a) => expandEnvVars(a, spawnEnv)),
        processId,
        this._cols,
        extraEnv,
      );
      control._proc = proc;
      for await (const event of proc.events()) {
        if (event.to?.target === "shell") {
          this._emitControlEvent({ ...event, control: true });
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

  async *handle$prompt_submit(obj) {
    this._notifyControls({
      type: "command_run",
      text: obj.text,
      command: obj.command,
      args: obj.args,
      parts: obj.parts,
      process_id: obj.process_id,
      prompt_name: obj.prompt_name,
    });

    // Determine effective zone, parsing @left / @right prefix from raw text.
    let effectiveZone = obj.zone ?? "main";
    let text = obj.text;
    if (text !== undefined) {
      const m = /^@(left|right|tab|float)\s+/.exec(text);
      if (m) {
        const dir = m[1];
        const base = typeof effectiveZone === "string" ? effectiveZone : "main";
        if (dir === "tab") effectiveZone = { base, newTab: true };
        else if (dir === "float") effectiveZone = { base, float: true };
        else effectiveZone = { base, [dir]: 1 };
        text = text.slice(m[0].length);
      }
    }

    // When output is redirected to another zone, emit the echo separately to
    // the source zone so the command stays visible where it was typed.
    if (typeof effectiveZone !== "string" && obj.echo_html) {
      yield {
        type: "echo",
        to: { target: "terminal" },
        zone: obj.zone ?? "main",
        echo_html: obj.echo_html,
      };
      obj = { ...obj, echo_html: null };
    }

    if (text !== undefined) {
      let ast;
      try {
        ast = bashParser(text, {
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
        const echo_html = first ? (obj.echo_html ?? null) : null;
        const prompt_name = first ? (obj.prompt_name ?? null) : null;
        first = false;
        const background = node.async === true;
        yield* builder.runNode(node, echo_html, prompt_name, background, effectiveZone);
      }
      return;
    }

    const echo_html = obj.echo_html ?? null;
    const prompt_name = obj.prompt_name ?? null;
    const [cmd, ...args] = obj.parts ?? [obj.command, ...(obj.args || [])];

    if (cmd in this._builtins) {
      const processId = this._generateProcessId();
      yield {
        type: "cell_create",
        to: { target: "terminal", cell: "main" },
        address: { process: processId },
        echo_html,
        mode: "auto",
        zone: effectiveZone,
        background: obj.background ?? false,
      };
      let return_code = 0;
      try {
        yield* this._runBuiltin(cmd, args, processId);
      } catch (err) {
        yield makeError(err);
        return_code = 1;
      }
      yield {
        type: "process_close",
        to: { target: "terminal" },
        process_id: processId,
        return_code,
      };
      return;
    }

    const processId = this._generateProcessId();
    const proc = new Process(cmd, args, processId, this._cols);
    this._processes.set(processId, proc);

    yield {
      type: "cell_create",
      to: { target: "terminal", cell: "main" },
      address: { process: processId },
      echo_html,
      mode: "auto",
      zone: effectiveZone,
      background: obj.background ?? false,
      pid: proc.pid,
    };

    for await (const event of proc.events()) {
      if (event.type === "process_close" && event.process_id === processId) {
        this._processes.delete(processId);
      }
      // Inject zone into cell_create/prompt_create from subprocesses.
      // If the subprocess set an object descriptor (e.g. @tab, @left), it was
      // intentional — respect it. Only override null/undefined and the hardcoded
      // "main" default that every cq sub-shell emits on startup. Preserve any
      // explicit zone name (e.g. "zone-2") that the sub-shell set based on the
      // zone it received via prompt_submit.
      if (
        (event.type === "cell_create" || event.type === "prompt_create") &&
        (event.zone == null || event.zone === "main")
      ) {
        yield { ...event, zone: effectiveZone };
      } else {
        yield event;
      }
    }
  }

  handle$prompt_close(_obj) {
    this._shutdown = true;
  }

  async *handle$prompt_binding(obj) {
    const cmd = this._keyBindings.get(obj.name);
    if (!cmd) return;
    const savedInput = process.env.CQ_PROMPT_INPUT;
    const savedPosition = process.env.CQ_PROMPT_POSITION;
    process.env.CQ_PROMPT_INPUT = obj.text ?? "";
    process.env.CQ_PROMPT_POSITION = String(obj.position ?? 0);
    try {
      yield* this.handle$prompt_submit({
        type: "prompt_submit",
        to: obj.to,
        text: cmd,
        echo_html: null,
        zone: obj.zone ?? "main",
      });
    } finally {
      if (savedInput === undefined) delete process.env.CQ_PROMPT_INPUT;
      else process.env.CQ_PROMPT_INPUT = savedInput;
      if (savedPosition === undefined) delete process.env.CQ_PROMPT_POSITION;
      else process.env.CQ_PROMPT_POSITION = savedPosition;
    }
  }

  async *_runBuiltin(name, args, processId) {
    for await (const item of this._builtins[name](args, processId)) {
      yield* this._dispatchCommand(item);
    }
  }

  async *_dispatchCommand(obj) {
    const handler = this[`handle$${obj.type}`];
    if (!handler) {
      return;
    }
    const result = handler.call(this, obj);
    if (result && result[Symbol.asyncIterator]) {
      yield* withErrorCatch(result);
    } else {
      await result;
    }
  }
}

module.exports = { Shell };
