const { describe, test, expect } = require("bun:test");
const { Shell } = require("../src/shell");

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
    expect(out[0]).toMatchObject({ type: "new", cell_id: "p1" });
    expect(typeof out[0].process_id).toBe("number");
    expect(out[out.length - 1]).toMatchObject({
      type: "close",
      cell_id: "p1",
      return_code: 0,
    });
  });

  test("includes echo in new event when provided", async () => {
    const out = await run({
      type: "run",
      command: "true",
      cell_id: "p1",
      echo: "ls -l",
    });
    expect(out[0]).toMatchObject({
      type: "new",
      cell_id: "p1",
      mode: "text",
      data: { text: "> ls -l" },
    });
  });

  test("omits echo in new event when not provided", async () => {
    const out = await run({ type: "run", command: "true", cell_id: "p1" });
    expect(out[0].echo).toBeUndefined();
  });

  test("captures stdout", async () => {
    const out = await run({
      type: "run",
      command: "echo",
      args: ["hello"],
      cell_id: "p1",
    });
    const stdout = out.filter(
      (e) => e.type === "send" && e.data.stream === "stdout",
    );
    expect(stdout[0].data.text).toContain("hello");
  });

  test("captures stderr", async () => {
    const out = await run({
      type: "run",
      command: "sh",
      args: ["-c", "echo err >&2"],
      cell_id: "p1",
    });
    const stderr = out.filter(
      (e) => e.type === "send" && e.data.stream === "stderr",
    );
    expect(stderr[0].data.text).toContain("err");
  });

  test("non-zero return code", async () => {
    const out = await run({ type: "run", command: "false", cell_id: "p1" });
    expect(out.find((e) => e.type === "close")).toMatchObject({
      return_code: 1,
    });
  });

  test("generates cell_id when not provided", async () => {
    const out = await run({ type: "run", command: "true" });
    expect(out[0].type).toBe("new");
    expect(typeof out[0].cell_id).toBe("string");
  });

  test("duplicate cell_id emits error", async () => {
    const out = await run(
      { type: "run", command: "sleep", args: ["0.2"], cell_id: "p1" },
      { type: "run", command: "true", cell_id: "p1" },
    );
    const error = out.find((e) => e.type === "error");
    expect(error).toBeDefined();
    expect(error.cell_id).toBe("p1");
  });

  test("ENOENT emits error", async () => {
    const out = await run({
      type: "run",
      command: "no_such_command_xyz",
      cell_id: "p1",
    });
    const error = out.find((e) => e.type === "error");
    expect(error).toMatchObject({ type: "error", cell_id: "p1" });
    expect(error.message).toContain("not found");
  });
});

describe("parse", () => {
  test("runs the parsed command", async () => {
    const out = await run({ type: "parse", text: "echo hello", cell_id: "p1" });
    expect(out[0]).toMatchObject({ type: "new", cell_id: "p1" });
    const stdout = out.filter(
      (e) => e.type === "send" && e.data.stream === "stdout",
    );
    expect(stdout[0].data.text).toContain("hello");
  });

  test("uses provided cell_id", async () => {
    const out = await run({ type: "parse", text: "true", cell_id: "my-id" });
    expect(out[0]).toMatchObject({ type: "new", cell_id: "my-id" });
  });

  test("generates cell_id when null", async () => {
    const out = await run({ type: "parse", text: "true", cell_id: null });
    expect(out[0].type).toBe("new");
    expect(typeof out[0].cell_id).toBe("string");
  });

  test("handles multiple args", async () => {
    const out = await run({
      type: "parse",
      text: "echo foo bar baz",
      cell_id: "p1",
    });
    const stdout = out.filter(
      (e) => e.type === "send" && e.data.stream === "stdout",
    );
    expect(stdout[0].data.text).toContain("foo bar baz");
  });
});

describe("input / close_stdin", () => {
  test("sends text to process stdin", async () => {
    const out = await run(
      { type: "run", command: "cat", cell_id: "p1" },
      { type: "input", cell_id: "p1", text: "hello\n" },
      { type: "close_stdin", cell_id: "p1" },
    );
    const stdout = out.filter(
      (e) => e.type === "send" && e.data.stream === "stdout",
    );
    expect(stdout.map((e) => e.data.text).join("")).toContain("hello");
  });
});

describe("wait", () => {
  test("delays before next command", async () => {
    const start = Date.now();
    await run(
      { type: "wait", seconds: 0.1 },
      { type: "run", command: "true", cell_id: "p1" },
    );
    expect(Date.now() - start).toBeGreaterThanOrEqual(100);
  });

  test("does not block stdout from concurrent processes", async () => {
    const out = await run(
      { type: "run", command: "echo", args: ["hi"], cell_id: "p1" },
      { type: "wait", seconds: 0.1 },
    );
    const stdout = out.filter((e) => e.type === "send");
    expect(stdout.length).toBeGreaterThan(0);
  });
});
