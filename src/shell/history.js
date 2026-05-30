const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HISTORY_FILE = path.join(os.homedir(), ".config", "buche", "history.jsonl");

class ShellHistory {
  constructor() {
    this._entries = [];
    this._load();
  }

  _load() {
    try {
      this._entries = fs
        .readFileSync(HISTORY_FILE, "utf8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l, i) => {
          const entry = JSON.parse(l);
          if (!entry.id) entry.id = `__legacy_${i}`;
          return entry;
        });
    } catch {
      this._entries = [];
    }
  }

  // Append an entry, skipping consecutive duplicates.
  push(entry) {
    const last = this._entries[this._entries.length - 1];
    if (last && last.text === entry.text && last.prompt_id === entry.prompt_id) return;
    try {
      fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
      fs.appendFileSync(HISTORY_FILE, JSON.stringify(entry) + "\n");
    } catch {}
    this._entries.push(entry);
  }

  // Return the most recent entry whose text starts with `text`, or null.
  filigrane(text) {
    if (!text) return null;
    for (let i = this._entries.length - 1; i >= 0; i--) {
      const e = this._entries[i];
      if (e.text.startsWith(text) && e.text.length > text.length) return e.text;
    }
    return null;
  }

  // Find prev/next entry relative to anchor_id, filtered by text.
  // Returns { text, anchor_id, filter } or { text: null, anchor_id: null, filter }.
  navigate({ direction, anchor_id, filter }) {
    const relevant = this._entries;

    let anchorIdx;
    if (anchor_id === null) {
      anchorIdx = relevant.length;
    } else {
      anchorIdx = relevant.findIndex((e) => e.id === anchor_id);
      if (anchorIdx === -1) anchorIdx = relevant.length;
    }

    let found = null;
    if (direction === "prev") {
      for (let i = anchorIdx - 1; i >= 0; i--) {
        if (!filter || relevant[i].text.includes(filter)) { found = relevant[i]; break; }
      }
    } else {
      for (let i = anchorIdx + 1; i < relevant.length; i++) {
        if (!filter || relevant[i].text.includes(filter)) { found = relevant[i]; break; }
      }
    }

    return {
      text: found ? found.text : null,
      anchor_id: found ? found.id : null,
      filter: filter ?? null,
    };
  }
}

module.exports = { ShellHistory };
