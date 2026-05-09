"use strict";

const { describe, test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

// Isolate each test in its own temp directory tree.
let tmpDir;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "buche-config-test-"));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Create a file (and any missing parent dirs), write YAML content.
function write(relPath, content) {
  const full = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf8");
  return full;
}

// Load config with XDG env vars pointing into tmpDir so real user configs
// are never consulted.
function loadConfig(cwd) {
  // Bust require cache so XDG env changes are picked up each call.
  const mod = path.resolve(__dirname, "../../src/shell/config.js");
  delete require.cache[mod];
  return require(mod).loadConfig(cwd);
}

// ── env ──────────────────────────────────────────────────────────────────────

describe("env", () => {
  beforeEach(() => {
    process.env.XDG_CONFIG_HOME = path.join(tmpDir, "xdg-home");
    process.env.XDG_CONFIG_DIRS = path.join(tmpDir, "xdg-dirs");
  });
  afterEach(() => {
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_CONFIG_DIRS;
  });

  test("string value is exported", () => {
    const cwd = path.join(tmpDir, "project");
    write("project/.buche.yaml", "env:\n  FOO: hello\n");
    const { env } = loadConfig(cwd);
    assert.deepEqual(env.get("FOO"), { value: "hello", export: true });
  });

  test("number value is coerced to string", () => {
    const cwd = path.join(tmpDir, "project");
    write("project/.buche.yaml", "env:\n  PORT: 3000\n");
    const { env } = loadConfig(cwd);
    assert.deepEqual(env.get("PORT"), { value: "3000", export: true });
  });

  test("object form with export: false", () => {
    const cwd = path.join(tmpDir, "project");
    write("project/.buche.yaml", "env:\n  FOO:\n    value: bar\n    export: false\n");
    const { env } = loadConfig(cwd);
    assert.deepEqual(env.get("FOO"), { value: "bar", export: false });
  });

  test("array value joined with default separator", () => {
    const cwd = path.join(tmpDir, "project");
    write("project/.buche.yaml", "env:\n  PATH_EXTRA:\n    value: [/a, /b, /c]\n");
    const { env } = loadConfig(cwd);
    assert.equal(env.get("PATH_EXTRA").value, "/a:/b:/c");
  });

  test("array value joined with custom separator", () => {
    const cwd = path.join(tmpDir, "project");
    write("project/.buche.yaml", "env:\n  LIST:\n    value: [x, y]\n    separator: ','\n");
    const { env } = loadConfig(cwd);
    assert.equal(env.get("LIST").value, "x,y");
  });

  test("append prepends current env value", () => {
    const orig = process.env.MYVAR;
    process.env.MYVAR = "/existing";
    try {
      const cwd = path.join(tmpDir, "project");
      write("project/.buche.yaml", "env:\n  MYVAR:\n    value: /new\n    append: true\n");
      const { env } = loadConfig(cwd);
      assert.equal(env.get("MYVAR").value, "/existing:/new");
    } finally {
      if (orig === undefined) delete process.env.MYVAR;
      else process.env.MYVAR = orig;
    }
  });

  test("higher-priority config wins over lower", () => {
    const cwd = path.join(tmpDir, "project", "sub");
    write("project/.buche.yaml", "env:\n  FOO: parent\n");
    write("project/sub/.buche.yaml", "env:\n  FOO: child\n");
    const { env } = loadConfig(cwd);
    assert.equal(env.get("FOO").value, "child");
  });
});

// ── control ───────────────────────────────────────────────────────────────────

describe("control", () => {
  beforeEach(() => {
    process.env.XDG_CONFIG_HOME = path.join(tmpDir, "xdg-home");
    process.env.XDG_CONFIG_DIRS = path.join(tmpDir, "xdg-dirs");
  });
  afterEach(() => {
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_CONFIG_DIRS;
  });

  test("parses cmd and args", () => {
    const cwd = path.join(tmpDir, "project");
    write("project/.buche.yaml", "control:\n  myctl: myprogram --flag value\n");
    const { control } = loadConfig(cwd);
    const entry = control.get("myctl");
    assert.equal(entry.cmd, "myprogram");
    assert.deepEqual(entry.args, ["--flag", "value"]);
  });

  test("configDir is the directory of the defining config file", () => {
    const cwd = path.join(tmpDir, "project");
    write("project/.buche.yaml", "control:\n  myctl: myprog\n");
    const { control } = loadConfig(cwd);
    assert.equal(control.get("myctl").configDir, path.join(tmpDir, "project"));
  });

  test("higher-priority config overrides lower for same name", () => {
    const cwd = path.join(tmpDir, "project", "sub");
    write("project/.buche.yaml", "control:\n  ctl: parent-prog\n");
    write("project/sub/.buche.yaml", "control:\n  ctl: child-prog\n");
    const { control } = loadConfig(cwd);
    assert.equal(control.get("ctl").cmd, "child-prog");
  });

  test("invalid/empty command string is skipped", () => {
    const cwd = path.join(tmpDir, "project");
    write("project/.buche.yaml", "control:\n  bad: ''\n");
    const { control } = loadConfig(cwd);
    assert.equal(control.has("bad"), false);
  });
});

// ── interface ─────────────────────────────────────────────────────────────────

describe("interface", () => {
  beforeEach(() => {
    process.env.XDG_CONFIG_HOME = path.join(tmpDir, "xdg-home");
    process.env.XDG_CONFIG_DIRS = path.join(tmpDir, "xdg-dirs");
  });
  afterEach(() => {
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_CONFIG_DIRS;
  });

  test("null when no interface key present", () => {
    const cwd = path.join(tmpDir, "project");
    write("project/.buche.yaml", "env:\n  X: 1\n");
    const { interface: iface } = loadConfig(cwd);
    assert.equal(iface, null);
  });

  test("shallow merge: higher-priority keys win", () => {
    const cwd = path.join(tmpDir, "project", "sub");
    write("project/.buche.yaml", "interface:\n  theme: dark\n  font: mono\n");
    write("project/sub/.buche.yaml", "interface:\n  theme: light\n");
    const { interface: iface } = loadConfig(cwd);
    assert.equal(iface.theme, "light");
    assert.equal(iface.font, "mono");
  });
});

// ── local config walking ──────────────────────────────────────────────────────

describe("local config walking", () => {
  beforeEach(() => {
    process.env.XDG_CONFIG_HOME = path.join(tmpDir, "xdg-home");
    process.env.XDG_CONFIG_DIRS = path.join(tmpDir, "xdg-dirs");
  });
  afterEach(() => {
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_CONFIG_DIRS;
  });

  test("picks up .buche.yaml from ancestor directory", () => {
    const cwd = path.join(tmpDir, "a", "b", "c");
    fs.mkdirSync(cwd, { recursive: true });
    write("a/.buche.yaml", "env:\n  FOUND: yes\n");
    const { env } = loadConfig(cwd);
    assert.equal(env.get("FOUND")?.value, "yes");
  });

  test("ignore-parents stops walking at that directory", () => {
    const cwd = path.join(tmpDir, "a", "b");
    write("a/b/.buche.yaml", "ignore-parents: true\nenv:\n  LOCAL: b\n");
    write("a/.buche.yaml", "env:\n  PARENT: a\n");
    const { env } = loadConfig(cwd);
    assert.equal(env.get("LOCAL")?.value, "b");
    assert.equal(env.has("PARENT"), false);
  });

  test("ignore-global suppresses XDG configs", () => {
    const cwd = path.join(tmpDir, "project");
    write("project/.buche.yaml", "ignore-global: true\n");
    write("xdg-home/buche/config.yaml", "env:\n  GLOBAL: yes\n");
    const { env } = loadConfig(cwd);
    assert.equal(env.has("GLOBAL"), false);
  });

  test("malformed YAML is silently skipped", () => {
    const cwd = path.join(tmpDir, "project");
    write("project/.buche.yaml", "env: [invalid yaml: {{\n");
    assert.doesNotThrow(() => loadConfig(cwd));
  });
});

// ── XDG priority ──────────────────────────────────────────────────────────────

describe("XDG config priority", () => {
  afterEach(() => {
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_CONFIG_DIRS;
  });

  test("XDG_CONFIG_HOME is consulted before XDG_CONFIG_DIRS", () => {
    process.env.XDG_CONFIG_HOME = path.join(tmpDir, "xdg-home");
    process.env.XDG_CONFIG_DIRS = path.join(tmpDir, "xdg-dirs");
    write("xdg-home/buche/config.yaml", "env:\n  FROM: home\n");
    write("xdg-dirs/buche/config.yaml", "env:\n  FROM: dirs\n");
    const cwd = path.join(tmpDir, "empty");
    fs.mkdirSync(cwd, { recursive: true });
    const { env } = loadConfig(cwd);
    assert.equal(env.get("FROM").value, "home");
  });

  test("local .buche.yaml takes priority over XDG_CONFIG_HOME", () => {
    process.env.XDG_CONFIG_HOME = path.join(tmpDir, "xdg-home");
    process.env.XDG_CONFIG_DIRS = path.join(tmpDir, "xdg-dirs");
    write("xdg-home/buche/config.yaml", "env:\n  FOO: global\n");
    write("project/.buche.yaml", "env:\n  FOO: local\n");
    const { env } = loadConfig(path.join(tmpDir, "project"));
    assert.equal(env.get("FOO").value, "local");
  });

  test("multiple XDG_CONFIG_DIRS entries respected in order", () => {
    const dir1 = path.join(tmpDir, "xdg-dir1");
    const dir2 = path.join(tmpDir, "xdg-dir2");
    process.env.XDG_CONFIG_HOME = path.join(tmpDir, "xdg-home-empty");
    process.env.XDG_CONFIG_DIRS = `${dir1}:${dir2}`;
    write("xdg-dir1/buche/config.yaml", "env:\n  FROM: dir1\n");
    write("xdg-dir2/buche/config.yaml", "env:\n  FROM: dir2\n");
    const cwd = path.join(tmpDir, "empty");
    fs.mkdirSync(cwd, { recursive: true });
    const { env } = loadConfig(cwd);
    assert.equal(env.get("FROM").value, "dir1");
  });
});

// ── sources ───────────────────────────────────────────────────────────────────

describe("sources", () => {
  beforeEach(() => {
    process.env.XDG_CONFIG_HOME = path.join(tmpDir, "xdg-home");
    process.env.XDG_CONFIG_DIRS = path.join(tmpDir, "xdg-dirs");
  });
  afterEach(() => {
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_CONFIG_DIRS;
  });

  test("sources are loaded and merged", () => {
    const cwd = path.join(tmpDir, "project");
    write("project/.buche.yaml", "sources:\n  - extra.yaml\n");
    write("project/extra.yaml", "env:\n  FROM_SOURCE: yes\n");
    const { env } = loadConfig(cwd);
    assert.equal(env.get("FROM_SOURCE")?.value, "yes");
  });

  test("main config takes priority over sourced files", () => {
    const cwd = path.join(tmpDir, "project");
    write("project/.buche.yaml", "sources:\n  - extra.yaml\nenv:\n  FOO: main\n");
    write("project/extra.yaml", "env:\n  FOO: source\n");
    const { env } = loadConfig(cwd);
    assert.equal(env.get("FOO").value, "main");
  });

  test("missing source file is silently skipped", () => {
    const cwd = path.join(tmpDir, "project");
    write("project/.buche.yaml", "sources:\n  - nonexistent.yaml\n");
    assert.doesNotThrow(() => loadConfig(cwd));
  });
});
