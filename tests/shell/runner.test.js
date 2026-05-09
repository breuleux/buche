"use strict";

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execSync } = require("node:child_process");
const { Shell } = require("../../src/shell/runner");

// ── Isolation ─────────────────────────────────────────────────────────────────
// Run from a temp dir with no .buche.yaml and XDG pointing at empty dirs so
// _applyConfig() loads nothing and spawns no control processes.

let _origCwd, _origXdgHome, _origXdgDirs, _isolateDir;

before(() => {
  _origCwd = process.cwd();
  _origXdgHome = process.env.XDG_CONFIG_HOME;
  _origXdgDirs = process.env.XDG_CONFIG_DIRS;
  _isolateDir = fs.mkdtempSync(path.join(os.tmpdir(), "buche-runner-test-"));
  process.chdir(_isolateDir);
  process.env.XDG_CONFIG_HOME = path.join(_isolateDir, "xdg");
  process.env.XDG_CONFIG_DIRS = path.join(_isolateDir, "xdg");
});

after(() => {
  process.chdir(_origCwd);
  if (_origXdgHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = _origXdgHome;
  if (_origXdgDirs === undefined) delete process.env.XDG_CONFIG_DIRS;
  else process.env.XDG_CONFIG_DIRS = _origXdgDirs;
  fs.rmSync(_isolateDir, { recursive: true, force: true });
});

// ── Helpers ──────────────────────────────────────────────────────────────────

// Feed a fixed list of items into a Shell and collect all output events.
async function run(...items) {
  const shell = new Shell();
  const results = [];
  async function* stream() {
    for (const item of items) yield item;
  }
  for await (const event of shell.run(stream())) results.push(event);
  return results;
}

// Returns a controllable input stream and push/end functions for interactive tests.
function makeController() {
  const queue = [];
  let resolve = null;
  let done = false;

  const push = (item) => {
    queue.push(item);
    if (resolve) {
      const r = resolve;
      resolve = null;
      r();
    }
  };
  const end = () => {
    done = true;
    if (resolve) {
      const r = resolve;
      resolve = null;
      r();
    }
  };
  async function* stream() {
    while (true) {
      while (queue.length > 0) yield queue.shift();
      if (done) break;
      await new Promise((r) => (resolve = r));
    }
  }
  return { push, end, stream };
}

// Partial-match helper: asserts that every key in `expected` equals actual[key].
function match(actual, expected) {
  for (const [k, v] of Object.entries(expected)) {
    if (v !== null && typeof v === "object") {
      match(actual[k], v);
    } else {
      assert.strictEqual(actual[k], v, `key "${k}": expected ${v}, got ${actual[k]}`);
    }
  }
}

// ── Initialisation ────────────────────────────────────────────────────────────

describe("init", () => {
  test("emits prompt_create on startup", async () => {
    const out = await run();
    const pc = out.find((e) => e.type === "prompt_create");
    assert.ok(pc !== undefined, "expected a prompt_create event");
    match(pc, { to: { target: "terminal" } });
  });
});

// ── process lifecycle ─────────────────────────────────────────────────────────

describe("prompt_submit (command)", () => {
  test("emits cell_create with correct shape", async () => {
    const out = await run({ type: "prompt_submit", command: "true", args: [] });
    const cc = out.find((e) => e.type === "cell_create");
    assert.ok(cc !== undefined, "expected cell_create");
    match(cc, { to: { target: "terminal", cell: "main" }, mode: "auto", background: false });
    assert.ok(typeof cc.address?.process === "string", "address.process should be a string");
  });

  test("emits process_close with return_code 0 for true", async () => {
    const out = await run({ type: "prompt_submit", command: "true" });
    const pc = out.find((e) => e.type === "process_close");
    assert.ok(pc !== undefined, "expected process_close");
    assert.strictEqual(pc.return_code, 0);
    match(pc, { to: { target: "terminal" } });
  });

  test("cell_create address.process matches process_close.process_id", async () => {
    const out = await run({ type: "prompt_submit", command: "true" });
    const cc = out.find((e) => e.type === "cell_create");
    const pc = out.find((e) => e.type === "process_close");
    assert.strictEqual(cc.address.process, pc.process_id);
  });

  test("non-zero return code for false", async () => {
    const out = await run({ type: "prompt_submit", command: "false" });
    const pc = out.find((e) => e.type === "process_close");
    assert.ok(pc.return_code !== 0);
  });

  test("captures stdout as send events", async () => {
    const out = await run({ type: "prompt_submit", command: "echo", args: ["hello"] });
    const sends = out.filter((e) => e.type === "send" && e.stream === "stdout");
    assert.ok(sends.some((e) => e.text?.includes("hello")), "expected stdout containing 'hello'");
  });

  test("send events carry the process address", async () => {
    const out = await run({ type: "prompt_submit", command: "echo", args: ["hi"] });
    const cc = out.find((e) => e.type === "cell_create");
    const sends = out.filter((e) => e.type === "send" && e.stream === "stdout");
    assert.ok(sends.every((e) => e.address?.process === cc.address.process));
  });

  test("captures stderr as send events with stream=stderr", async () => {
    const out = await run({
      type: "prompt_submit",
      command: "sh",
      args: ["-c", "echo err >&2"],
    });
    const stderr = out.filter((e) => e.type === "send" && e.stream === "stderr");
    assert.ok(stderr.some((e) => e.text?.includes("err")), "expected stderr containing 'err'");
  });

  test("echo_html forwarded into cell_create", async () => {
    const out = await run({
      type: "prompt_submit",
      command: "true",
      echo_html: "<b>cmd</b>",
    });
    const cc = out.find((e) => e.type === "cell_create");
    assert.strictEqual(cc.echo_html, "<b>cmd</b>");
  });

  test("background flag forwarded into cell_create", async () => {
    const out = await run({
      type: "prompt_submit",
      command: "true",
      background: true,
    });
    const cc = out.find((e) => e.type === "cell_create");
    assert.strictEqual(cc.background, true);
  });

  test("ENOENT emits an error event", async () => {
    const out = await run({ type: "prompt_submit", command: "no_such_command_xyz" });
    const err = out.find((e) => e.type === "error");
    assert.ok(err !== undefined, "expected an error event");
    assert.ok(err.message?.includes("ENOENT"), `message: ${err.message}`);
  });
});

// ── shell text parsing ────────────────────────────────────────────────────────

describe("prompt_submit (text)", () => {
  test("runs a simple command from text", async () => {
    const out = await run({ type: "prompt_submit", text: "true" });
    const pc = out.find((e) => e.type === "process_close");
    assert.ok(pc !== undefined);
    assert.strictEqual(pc.return_code, 0);
  });

  test("captures stdout from text command", async () => {
    const out = await run({ type: "prompt_submit", text: "echo hello" });
    const sends = out.filter((e) => e.type === "send" && e.stream === "stdout");
    assert.ok(sends.some((e) => e.text?.includes("hello")));
  });

  test("handles arguments in text", async () => {
    const out = await run({ type: "prompt_submit", text: "echo foo bar baz" });
    const text = out.filter((e) => e.type === "send" && e.stream === "stdout")
      .map((e) => e.text).join("");
    assert.ok(text.includes("foo") && text.includes("bar") && text.includes("baz"));
  });
});

// ── input / close ─────────────────────────────────────────────────────────────

describe("input routing", () => {
  test("sends text to process stdin", async () => {
    const ctrl = makeController();
    const shell = new Shell();
    const results = [];

    ctrl.push({
      type: "prompt_submit",
      command: "sh",
      args: ["-c", "read line; echo \"got:$line\""],
    });

    for await (const event of shell.run(ctrl.stream())) {
      results.push(event);
      if (event.type === "cell_create") {
        ctrl.push({ type: "input", to: { process: event.address.process }, text: "world\n" });
      }
      if (event.type === "process_close") ctrl.end();
    }

    const text = results
      .filter((e) => e.type === "send" && e.stream === "stdout")
      .map((e) => e.text)
      .join("");
    assert.ok(text.includes("got:world"), `stdout: ${JSON.stringify(text)}`);
  });

  test("close terminates the process", async () => {
    const ctrl = makeController();
    const shell = new Shell();
    const results = [];

    ctrl.push({ type: "prompt_submit", command: "cat" });

    for await (const event of shell.run(ctrl.stream())) {
      results.push(event);
      if (event.type === "cell_create") {
        ctrl.push({ type: "close", to: { process: event.address.process } });
      }
      if (event.type === "process_close") ctrl.end();
    }

    assert.ok(results.find((e) => e.type === "process_close") !== undefined);
  });
});

// ── wait ──────────────────────────────────────────────────────────────────────

describe("wait", () => {
  test("delays before next event", async () => {
    const start = Date.now();
    await run(
      { type: "wait", seconds: 0.1 },
      { type: "prompt_submit", command: "true" },
    );
    assert.ok(Date.now() - start >= 100, "expected at least 100ms delay");
  });

  test("does not block output from prior process", async () => {
    const out = await run(
      { type: "prompt_submit", command: "echo", args: ["hi"] },
      { type: "wait", seconds: 0.1 },
    );
    assert.ok(out.filter((e) => e.type === "send").length > 0);
  });
});

// ── dataout (fd4) ─────────────────────────────────────────────────────────────

describe("dataout", () => {
  test("fd4 writes appear as send events with stream=dataout", async () => {
    const helloScript = path.resolve(_origCwd, "scripts/hello.js");
    const out = await run({
      type: "prompt_submit",
      command: "node",
      args: [helloScript],
    });
    const dataout = out.find((e) => e.type === "send" && e.stream === "dataout");
    assert.ok(dataout !== undefined, "expected a dataout event");
    assert.deepEqual(dataout.data, { type: "html", content: "<b>hello!</b>" });
  });

  test("scripts/hello.js falls back to stdout when fd4 unavailable", () => {
    const helloScript = path.resolve(_origCwd, "scripts/hello.js");
    const output = execSync(`node ${helloScript}`).toString();
    assert.ok(output.includes("hello"));
  });
});

// ── parse / highlight ─────────────────────────────────────────────────────────

describe("parse", () => {
  test("emits highlight event for text", async () => {
    const out = await run({
      type: "parse",
      text: "echo hello",
      position: 10,
      want_completions: false,
      request_id: "req1",
    });
    const hl = out.find((e) => e.type === "highlight");
    assert.ok(hl !== undefined, "expected highlight event");
    assert.strictEqual(hl.request_id, "req1");
    assert.ok(Array.isArray(hl.ranges));
  });

  test("emits complete event when want_completions is true", async () => {
    const out = await run({
      type: "parse",
      text: "ech",
      position: 3,
      want_completions: true,
      request_id: "req2",
    });
    const comp = out.find((e) => e.type === "complete");
    assert.ok(comp !== undefined, "expected complete event");
    assert.strictEqual(comp.request_id, "req2");
    assert.ok(Array.isArray(comp.completions));
  });
});
