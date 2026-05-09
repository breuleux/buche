"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const yaml = require("js-yaml");
const bashParser = require("bash-parser");

const DEFAULT_CONFIG_PATH = path.join(__dirname, "default-config.yaml");

// Returns config file paths in XDG priority order (highest first).
// XDG_CONFIG_HOME defaults to ~/.config; XDG_CONFIG_DIRS defaults to /etc/xdg.
function xdgConfigPaths() {
  const home = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  const dirs = (process.env.XDG_CONFIG_DIRS || "/etc/xdg").split(":").filter(Boolean);
  return [home, ...dirs].map((dir) => path.join(dir, "buche", "config.yaml"));
}

// [LATER] Verify a config file against the trust list in
// ~/.config/buche/allowed.json (stores file paths and their SHA-256 hashes).
// For now every file is considered trusted.
function isTrusted(_filePath) {
  return true;
}

// Parse a control command string into { cmd, args } using bash-parser.
// Returns null if the string is empty, not a string, or fails to parse.
function parseControlCmd(cmdStr) {
  if (typeof cmdStr !== "string") return null;
  let ast;
  try {
    ast = bashParser(cmdStr);
  } catch {
    return null;
  }
  const node = ast?.commands?.[0];
  if (!node || node.type !== "Command" || !node.name) return null;
  const cmd = node.name.text;
  const args = (node.suffix ?? [])
    .filter((item) => item.type !== "Redirect")
    .map((item) => item.text);
  return { cmd, args };
}

// Parse one env entry value into { value, export, append, separator }.
// Accepts:
//   "string" | number
//   { value, export?, append?, separator? }
//   { value: [...], append?, separator? }
function parseEnvEntry(raw) {
  if (typeof raw === "string" || typeof raw === "number") {
    return { value: String(raw), export: true, append: false, separator: ":" };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return null;

  const sep = typeof raw.separator === "string" ? raw.separator : ":";
  let value;
  if (Array.isArray(raw.value)) {
    value = raw.value.map(String).join(sep);
  } else if (raw.value !== undefined) {
    value = String(raw.value);
  } else {
    return null;
  }

  return {
    value,
    export: raw.export !== false,
    append: raw.append === true,
    separator: sep,
  };
}

// Load a YAML file. Returns { data, dir } or null if absent, unreadable, or
// not a plain object. Non-global files also go through the trust check.
function readConfigFile(filePath, { global: isGlobal = false } = {}) {
  if (!isGlobal && !isTrusted(filePath)) return null;
  let content;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
  let data;
  try {
    data = yaml.load(content);
  } catch {
    return null; // malformed YAML → skip silently
  }
  if (typeof data !== "object" || data === null || Array.isArray(data))
    return null;
  return { data, dir: path.dirname(path.resolve(filePath)) };
}

// Expand the `sources` list of one config entry, appending to `out`.
function expandSources(entry, out) {
  const sources = entry.data.sources;
  if (!Array.isArray(sources)) return;
  for (const src of sources) {
    if (typeof src !== "string") continue;
    const srcEntry = readConfigFile(path.resolve(entry.dir, src));
    if (srcEntry !== null) out.push(srcEntry);
  }
}

// Collect config entries in priority order (highest first).
function collectConfigs(cwd) {
  const entries = [];

  // Walk from cwd upward, stopping at the filesystem root or on ignore-parents.
  let dir = path.resolve(cwd);
  while (true) {
    const entry = readConfigFile(path.join(dir, ".buche.yaml"));
    if (entry !== null) {
      entries.push(entry);
      expandSources(entry, entries);
      if (entry.data["ignore-parents"]) break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // XDG global configs unless disabled by any higher-priority config.
  if (!entries.some((e) => e.data["ignore-global"])) {
    for (const configPath of xdgConfigPaths()) {
      const globalEntry = readConfigFile(configPath, { global: true });
      if (globalEntry !== null) {
        entries.push(globalEntry);
        expandSources(globalEntry, entries);
      }
    }
  }

  // Built-in default config — always loaded last (lowest priority).
  const defaultEntry = readConfigFile(DEFAULT_CONFIG_PATH, { global: true });
  if (defaultEntry !== null) entries.push(defaultEntry);

  return entries;
}

// Merge config entries (highest priority first) into a resolved config object.
// Returns { env: Map<name, {value, export}>, control: Map<name, {cmd, args}>, interface: object|null }
function mergeConfigs(entries) {
  const env = new Map(); // name → { value: string, export: boolean }
  const control = new Map(); // name → { cmd: string, args: string[] }
  let iface = null;

  // Process from lowest to highest priority so higher-priority writes win.
  for (const { data, dir } of [...entries].reverse()) {
    // env
    if (data.env && typeof data.env === "object" && !Array.isArray(data.env)) {
      for (const [name, raw] of Object.entries(data.env)) {
        const parsed = parseEnvEntry(raw);
        if (!parsed) continue;
        if (parsed.append) {
          const current = env.get(name)?.value ?? process.env[name] ?? "";
          const joined = current
            ? `${current}${parsed.separator}${parsed.value}`
            : parsed.value;
          env.set(name, { value: joined, export: parsed.export });
        } else {
          env.set(name, { value: parsed.value, export: parsed.export });
        }
      }
    }

    // control
    if (
      data.control &&
      typeof data.control === "object" &&
      !Array.isArray(data.control)
    ) {
      for (const [name, cmdStr] of Object.entries(data.control)) {
        const resolved = parseControlCmd(cmdStr);
        if (resolved) control.set(name, { ...resolved, configDir: dir });
      }
    }

    // interface — shallow merge; higher-priority keys win (written last)
    if (
      data.interface &&
      typeof data.interface === "object" &&
      !Array.isArray(data.interface)
    ) {
      iface = { ...(iface ?? {}), ...data.interface };
    }
  }

  return { env, control, interface: iface };
}

// Load and merge all applicable config files for cwd.
// Returns { env: Map, control: Map, interface: object|null }.
function loadConfig(cwd) {
  return mergeConfigs(collectConfigs(cwd));
}

module.exports = { loadConfig };
