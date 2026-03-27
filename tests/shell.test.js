const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { Shell } = require("../src/shell");

function matchObject(actual, expected) {
  for (const [key, val] of Object.entries(expected)) {
    if (val !== null && typeof val === "object") {
      matchObject(actual[key], val);
    } else {
      assert.strictEqual(actual[key], val);
    }
  }
}

async function run(...items) {
  const shell = new Shell();
  const results = [];
  async function* stream() {
    for (const item of items) yield item;
  }
  for await (const item of shell.run(stream())) results.push(item);
  return results;
}

describe("run", () => {
  test("emits new and close", async () => {
    const out = await run({ type: "run", command: "true", cell_id: "p1" });
    matchObject(out[0], { type: "new", cell_id: "p1" });
    assert.strictEqual(typeof out[0].process_id, "number");
    matchObject(out[out.length - 1], { type: "close", cell_id: "p1", return_code: 0 });
  });

  test("includes echo in new event when provided", async () => {
    const out = await run({ type: "run", command: "true", cell_id: "p1", echo: "ls -l" });
    matchObject(out[0], { type: "new", cell_id: "p1", mode: "auto", echo: "ls -l" });
  });

  test("omits echo in new event when not provided", async () => {
    const out = await run({ type: "run", command: "true", cell_id: "p1" });
    assert.strictEqual(out[0].echo, undefined);
  });

  test("captures stdout", async () => {
    const out = await run({ type: "run", command: "echo", args: ["hello"], cell_id: "p1" });
    const stdout = out.filter((e) => e.type === "send" && e.data.stream === "stdout");
    assert.ok(stdout[0].data.text.includes("hello"));
  });

  test("captures stderr", async () => {
    const out = await run({ type: "run", command: "sh", args: ["-c", "echo err >&2"], cell_id: "p1" });
    const stderr = out.filter((e) => e.type === "send" && e.data.stream === "stderr");
    assert.ok(stderr[0].data.text.includes("err"));
  });

  test("non-zero return code", async () => {
    const out = await run({ type: "run", command: "false", cell_id: "p1" });
    matchObject(out.find((e) => e.type === "close"), { return_code: 1 });
  });

  test("generates cell_id when not provided", async () => {
    const out = await run({ type: "run", command: "true" });
    assert.strictEqual(out[0].type, "new");
    assert.strictEqual(typeof out[0].cell_id, "string");
  });

  test("duplicate cell_id emits error", async () => {
    const out = await run(
      { type: "run", command: "sleep", args: ["0.2"], cell_id: "p1" },
      { type: "run", command: "true", cell_id: "p1" },
    );
    const error = out.find((e) => e.type === "error");
    assert.ok(error !== undefined);
    assert.strictEqual(error.cell_id, "p1");
  });

  test("ENOENT emits error", async () => {
    const out = await run({ type: "run", command: "no_such_command_xyz", cell_id: "p1" });
    const error = out.find((e) => e.type === "error");
    matchObject(error, { type: "error", cell_id: "p1" });
    assert.ok(error.message.includes("ENOENT"));
  });
});

describe("parse", () => {
  test("runs the parsed command", async () => {
    const out = await run({ type: "parse", text: "echo hello", cell_id: "p1" });
    matchObject(out[0], { type: "new", cell_id: "p1" });
    const stdout = out.filter((e) => e.type === "send" && e.data.stream === "stdout");
    assert.ok(stdout[0].data.text.includes("hello"));
  });

  test("uses provided cell_id", async () => {
    const out = await run({ type: "parse", text: "true", cell_id: "my-id" });
    matchObject(out[0], { type: "new", cell_id: "my-id" });
  });

  test("generates cell_id when null", async () => {
    const out = await run({ type: "parse", text: "true", cell_id: null });
    assert.strictEqual(out[0].type, "new");
    assert.strictEqual(typeof out[0].cell_id, "string");
  });

  test("handles multiple args", async () => {
    const out = await run({ type: "parse", text: "echo foo bar baz", cell_id: "p1" });
    const stdout = out.filter((e) => e.type === "send" && e.data.stream === "stdout");
    assert.ok(stdout[0].data.text.includes("foo bar baz"));
  });
});

describe("input / close_stdin", () => {
  test("sends text to process stdin", async () => {
    // Use a self-terminating command to avoid racing close_stdin with output flushing.
    const out = await run(
      { type: "run", command: "sh", args: ["-c", "read line; echo \"$line\""], cell_id: "p1" },
      { type: "input", cell_id: "p1", text: "hello\n" },
    );
    const stdout = out.filter((e) => e.type === "send" && e.data.stream === "stdout");
    assert.ok(stdout.map((e) => e.data.text).join("").includes("hello"));
  });

  test("close_stdin terminates process", async () => {
    const out = await run(
      { type: "run", command: "cat", cell_id: "p1" },
      { type: "close_stdin", cell_id: "p1" },
    );
    assert.ok(out.find((e) => e.type === "close") !== undefined);
  });
});

describe("wait", () => {
  test("delays before next command", async () => {
    const start = Date.now();
    await run(
      { type: "wait", seconds: 0.1 },
      { type: "run", command: "true", cell_id: "p1" },
    );
    assert.ok(Date.now() - start >= 100);
  });

  test("does not block stdout from concurrent processes", async () => {
    const out = await run(
      { type: "run", command: "echo", args: ["hi"], cell_id: "p1" },
      { type: "wait", seconds: 0.1 },
    );
    assert.ok(out.filter((e) => e.type === "send").length > 0);
  });
});
