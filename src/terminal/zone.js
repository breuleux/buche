import { PromptCollection } from "./prompt.js";

let _zoneCounter = 0;

export class Zone {
  constructor(name, bridge) {
    this.name = name;

    this.buffer = document.createElement("div");
    this.buffer.className = "zone-buffer";

    this._bufferWrap = document.createElement("scroll-fader");
    this._bufferWrap.classList.add("zone-buffer-wrap");

    this._inputContainer = document.createElement("div");
    this._inputContainer.className = "zone-input-container";

    this.node = document.createElement("div");
    this.node.className = "zone";
    this.node.dataset.zone = name;
    this.node.appendChild(this._bufferWrap);
    this.node.appendChild(this._inputContainer);

    // PromptCollection inserts its tab bar after _inputContainer (still inside zone node)
    this.promptCollection = new PromptCollection(this._inputContainer, bridge, name);
  }

  // Must be called after zone.node is connected to the DOM.
  initBuffer() {
    this._bufferWrap.inner.appendChild(this.buffer);
  }

  startResizeTracking(charWidth, cellPadding, onCols) {
    new ResizeObserver(() => {
      const width = this._bufferWrap.clientWidth;
      if (width > 0) {
        const cols = Math.max(1, Math.floor((width - cellPadding) / charWidth) - 2);
        onCols(this.name, cols);
      }
    }).observe(this._bufferWrap);
  }

  focus() {
    this.promptCollection.focus();
  }
}

export class ZoneManager {
  constructor(container, bridge) {
    this._container = container;
    this._bridge = bridge;
    this._zones = new Map(); // name → Zone
    // Stable adjacency: `${direction}:${baseName}` → zone name
    this._adjacency = new Map();

    const ctx = document.createElement("canvas").getContext("2d");
    ctx.font = "13px Consolas, Menlo, monospace";
    this._charWidth = ctx.measureText("M").width;
    this._cellPadding = 16;

    this._createZone("main", null);
  }

  _createZone(name, insertBefore) {
    const zone = new Zone(name, this._bridge);
    this._container.insertBefore(zone.node, insertBefore ?? null);
    zone.initBuffer();
    zone.startResizeTracking(this._charWidth, this._cellPadding, (zoneName, cols) => {
      this._bridge.sendCommand({ type: "resize", zone: zoneName, cols });
    });
    this._zones.set(name, zone);
    return zone;
  }

  allZones() {
    return this._zones.values();
  }

  // Resolve a descriptor to a Zone, creating the zone if needed.
  // descriptor: string | {base: string, left?: 1, right?: 1}
  resolveZone(descriptor) {
    return this._zones.get(this.resolveZoneName(descriptor));
  }

  // Returns the zone name for a descriptor, creating the zone if needed.
  resolveZoneName(descriptor) {
    if (!descriptor || descriptor === "main") return "main";
    if (typeof descriptor === "string") {
      if (!this._zones.has(descriptor)) this._createZone(descriptor, null);
      return descriptor;
    }
    const { base, left, right } = descriptor;
    const direction = left !== undefined ? "left" : "right";
    const key = `${direction}:${base}`;
    if (this._adjacency.has(key)) return this._adjacency.get(key);

    const newName = `zone-${++_zoneCounter}`;
    this._adjacency.set(key, newName);
    // Register reverse adjacency so the new zone knows its neighbour
    const reverse = direction === "left" ? "right" : "left";
    this._adjacency.set(`${reverse}:${newName}`, base);

    const baseNode = this._zones.get(base)?.node ?? null;
    const insertBefore = direction === "left" ? baseNode : baseNode?.nextSibling ?? null;
    this._createZone(newName, insertBefore);
    return newName;
  }

  // ── Prompt delegation ────────────────────────────────────────────────────

  addPrompt(instruction) {
    const zone = this.resolveZone(instruction.zone ?? "main");
    zone.promptCollection.addPrompt(instruction);
    zone.promptCollection.focus();
    return zone.name;
  }

  removePromptsByProcess(process_id) {
    for (const zone of this._zones.values()) {
      zone.promptCollection.removePromptsByProcess(process_id);
    }
  }

  setPrompt(instruction) {
    for (const zone of this._zones.values()) {
      zone.promptCollection.setPrompt(instruction);
    }
  }

  applyHighlight(instruction) {
    for (const zone of this._zones.values()) {
      zone.promptCollection.applyHighlight(instruction);
    }
  }

  applyComplete(instruction) {
    for (const zone of this._zones.values()) {
      zone.promptCollection.applyComplete(instruction);
    }
  }

  focusZone(zoneName) {
    const zone = this._zones.get(zoneName) ?? this._zones.get("main");
    if (!zone) return;
    // If the target zone has no prompts, fall back to main
    if (zone.promptCollection._prompts.length === 0 && zoneName !== "main") {
      this._zones.get("main")?.promptCollection.focus();
    } else {
      zone.promptCollection.focus();
    }
  }
}
