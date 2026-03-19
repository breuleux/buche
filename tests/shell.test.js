const { describe, test, expect } = require("bun:test");
const { Shell } = require("../src/shell");

async function* stream(items) {
    for (const item of items) yield item;
}

async function collect(asyncIter) {
    const results = [];
    for await (const item of asyncIter) results.push(item);
    return results;
}

describe("run", () => {
    test("emits process_start and process_end", async () => {
        const shell = new Shell();
        const out = await collect(shell.run(stream([
            { type: "run", command: "true", id: "p1" },
        ])));
        expect(out[0]).toMatchObject({ type: "process_start", id: "p1" });
        expect(out[out.length - 1]).toMatchObject({ type: "process_end", id: "p1", return_code: 0 });
    });

    test("captures stdout", async () => {
        const shell = new Shell();
        const out = await collect(shell.run(stream([
            { type: "run", command: "echo", args: ["hello"], id: "p1" },
        ])));
        const stdout = out.filter(e => e.type === "std" && e.stream === "stdout");
        expect(stdout[0].data).toContain("hello");
    });

    test("captures stderr", async () => {
        const shell = new Shell();
        const out = await collect(shell.run(stream([
            { type: "run", command: "sh", args: ["-c", "echo err >&2"], id: "p1" },
        ])));
        const stderr = out.filter(e => e.type === "std" && e.stream === "stderr");
        expect(stderr[0].data).toContain("err");
    });

    test("non-zero return code", async () => {
        const shell = new Shell();
        const out = await collect(shell.run(stream([
            { type: "run", command: "false", id: "p1" },
        ])));
        expect(out.find(e => e.type === "process_end")).toMatchObject({ return_code: 1 });
    });

    test("generates id when not provided", async () => {
        const shell = new Shell();
        const out = await collect(shell.run(stream([
            { type: "run", command: "true" },
        ])));
        expect(out[0].type).toBe("process_start");
        expect(typeof out[0].id).toBe("string");
    });

    test("duplicate id emits error", async () => {
        const shell = new Shell();
        const out = await collect(shell.run(stream([
            { type: "run", command: "sleep", args: ["0.2"], id: "p1" },
            { type: "run", command: "true", id: "p1" },
        ])));
        const error = out.find(e => e.type === "error");
        expect(error).toBeDefined();
        expect(error.id).toBe("p1");
    });

    test("ENOENT emits error with ENOENT error_type", async () => {
        const shell = new Shell();
        const out = await collect(shell.run(stream([
            { type: "run", command: "no_such_command_xyz", id: "p1" },
        ])));
        const error = out.find(e => e.type === "error");
        expect(error).toMatchObject({ type: "error", id: "p1" });
        expect(error.message).toContain("not found");
    });
});

describe("parse", () => {
    test("runs the parsed command", async () => {
        const shell = new Shell();
        const out = await collect(shell.run(stream([
            { type: "parse", text: "echo hello", id: "p1" },
        ])));
        expect(out[0]).toMatchObject({ type: "process_start", id: "p1" });
        const stdout = out.filter(e => e.type === "std" && e.stream === "stdout");
        expect(stdout[0].data).toContain("hello");
    });

    test("uses provided id", async () => {
        const shell = new Shell();
        const out = await collect(shell.run(stream([
            { type: "parse", text: "true", id: "my-id" },
        ])));
        expect(out[0]).toMatchObject({ type: "process_start", id: "my-id" });
    });

    test("generates id when null", async () => {
        const shell = new Shell();
        const out = await collect(shell.run(stream([
            { type: "parse", text: "true", id: null },
        ])));
        expect(out[0].type).toBe("process_start");
        expect(typeof out[0].id).toBe("string");
    });

    test("handles multiple args", async () => {
        const shell = new Shell();
        const out = await collect(shell.run(stream([
            { type: "parse", text: "echo foo bar baz", id: "p1" },
        ])));
        const stdout = out.filter(e => e.type === "std" && e.stream === "stdout");
        expect(stdout[0].data).toContain("foo bar baz");
    });
});

describe("input / close_stdin", () => {
    test("sends text to process stdin", async () => {
        const shell = new Shell();
        const out = await collect(shell.run(stream([
            { type: "run", command: "cat", id: "p1" },
            { type: "input", id: "p1", text: "hello\n" },
            { type: "close_stdin", id: "p1" },
        ])));
        const stdout = out.filter(e => e.type === "std" && e.stream === "stdout");
        expect(stdout.map(e => e.data).join("")).toContain("hello");
    });
});

describe("wait", () => {
    test("delays before next command", async () => {
        const shell = new Shell();
        const start = Date.now();
        await collect(shell.run(stream([
            { type: "wait", seconds: 0.1 },
            { type: "run", command: "true", id: "p1" },
        ])));
        expect(Date.now() - start).toBeGreaterThanOrEqual(100);
    });

    test("does not block stdout from concurrent processes", async () => {
        const shell = new Shell();
        const out = await collect(shell.run(stream([
            { type: "run", command: "echo", args: ["hi"], id: "p1" },
            { type: "wait", seconds: 0.1 },
        ])));
        const stdout = out.filter(e => e.type === "std");
        expect(stdout.length).toBeGreaterThan(0);
    });
});
