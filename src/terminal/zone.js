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

// ── ZoneGroup ──────────────────────────────────────────────────────────────
// Wraps one or more Zones and shows a top tab bar when there are 2+ tabs.

class ZoneGroup {
  constructor() {
    this._zones = [];
    this._activeIdx = 0;
    this._tabEls = new Map(); // zoneName → <button>
    this.onActivate = null; // (zoneName) => void — set by ZoneManager

    this.node = document.createElement("div");
    this.node.className = "zone-group";

    this._topTabs = document.createElement("div");
    this._topTabs.className = "zone-top-tabs";
    this.node.appendChild(this._topTabs);

    this._body = document.createElement("div");
    this._body.className = "zone-group-body";
    this.node.appendChild(this._body);
  }

  _updateSingleClass() {
    this.node.classList.toggle("zone-group-single", this._zones.length === 1);
  }

  addZone(zone) {
    const n = this._zones.length + 1;
    const tabEl = document.createElement("button");
    tabEl.className = "zone-top-tab";
    tabEl.textContent = `Tab ${n}`;
    tabEl.addEventListener("click", () => this.activateByName(zone.name));

    if (this._zones.length === 0) {
      tabEl.classList.add("active");
    } else {
      // Becoming multi-tab: show the bar (hidden until now) and hide the new zone
      this._topTabs.classList.add("visible");
      zone.node.classList.add("zone-hidden");
      // Tab bar now takes space — existing zone's Monaco editors need to re-measure
      const firstZone = this._zones[0];
      requestAnimationFrame(() => firstZone.promptCollection.layoutAll());
    }

    this._topTabs.appendChild(tabEl);
    this._tabEls.set(zone.name, tabEl);
    this._body.appendChild(zone.node);
    this._zones.push(zone);
    this._updateSingleClass();
  }

  activateByName(zoneName) {
    const idx = this._zones.findIndex(z => z.name === zoneName);
    if (idx === -1) return;

    if (idx !== this._activeIdx) {
      this._zones[this._activeIdx].node.classList.add("zone-hidden");
      this._tabEls.get(this._zones[this._activeIdx].name)?.classList.remove("active");

      this._activeIdx = idx;
      this._zones[idx].node.classList.remove("zone-hidden");
      this._tabEls.get(zoneName)?.classList.add("active");
      // Re-layout after unhiding — Monaco measures wrong while display:none
      requestAnimationFrame(() => this._zones[idx].promptCollection.layoutAll());
    }

    // Always focus after paint (even if already the active tab — e.g. cross-group cycling)
    requestAnimationFrame(() => this._zones[idx].promptCollection.focus());
    this.onActivate?.(zoneName);
  }

  tabEl(zoneName) {
    return this._tabEls.get(zoneName) ?? null;
  }

  activateLatest() {
    this.activateByName(this._zones[this._zones.length - 1].name);
  }

  cycleTab(delta) {
    if (this._zones.length < 2) return;
    const next = (this._activeIdx + delta + this._zones.length) % this._zones.length;
    this.activateByName(this._zones[next].name);
  }

  // Remove a zone by name. Returns the new active zone name, or null if the group is now empty.
  removeZone(zoneName) {
    const idx = this._zones.findIndex(z => z.name === zoneName);
    if (idx === -1) return null;

    const wasActive = idx === this._activeIdx;
    this._zones[idx].node.remove();
    this._tabEls.get(zoneName)?.remove();
    this._tabEls.delete(zoneName);
    this._zones.splice(idx, 1);

    if (this._zones.length === 0) return null;

    if (wasActive) {
      this._activeIdx = Math.max(0, idx - 1);
      const next = this._zones[this._activeIdx];
      next.node.classList.remove("zone-hidden");
      this._tabEls.get(next.name)?.classList.add("active");
      requestAnimationFrame(() => {
        next.promptCollection.layoutAll();
        next.promptCollection.focus();
      });
      this.onActivate?.(next.name);
    } else {
      if (idx < this._activeIdx) this._activeIdx--;
    }

    if (this._zones.length === 1) this._topTabs.classList.remove("visible");
    this._updateSingleClass();
    return this._zones[this._activeIdx].name;
  }

  get activeZone() {
    return this._zones[this._activeIdx];
  }
}

// ── ZoneManager ────────────────────────────────────────────────────────────

export class ZoneManager {
  constructor(container, bridge) {
    this._container = container;
    this._bridge = bridge;
    this._zones = new Map();  // zoneName → Zone
    this._groups = new Map(); // zoneName → ZoneGroup
    // Stable adjacency for left/right: `${direction}:${baseName}` → zone name
    this._adjacency = new Map();
    this._activeZoneName = "main";

    const ctx = document.createElement("canvas").getContext("2d");
    ctx.font = "13px Consolas, Menlo, monospace";
    this._charWidth = ctx.measureText("M").width;
    this._cellPadding = 16;

    this._createZoneInNewGroup("main", null);
    // The main zone starts focused; mark it after _groups is populated
    this._groups.get("main")?.tabEl("main")?.classList.add("zone-focused");
  }

  _setFocusedZone(zoneName) {
    this._groups.get(this._activeZoneName)?.tabEl(this._activeZoneName)?.classList.remove("zone-focused");
    this._activeZoneName = zoneName;
    this._groups.get(zoneName)?.tabEl(zoneName)?.classList.add("zone-focused");
  }

  _updateMultiLayout() {
    const groups = new Set(this._groups.values());
    const isMulti = groups.size > 1;
    for (const group of groups) {
      group.node.classList.toggle("zone-group-multi", isMulti);
    }
  }

  removeZoneIfEmpty(zoneName) {
    if (zoneName === "main") return;
    const zone = this._zones.get(zoneName);
    if (!zone) return;
    if (zone.buffer.children.length > 0 || zone.promptCollection._prompts.length > 0) return;

    const group = this._groups.get(zoneName);
    const newActive = group.removeZone(zoneName);
    this._zones.delete(zoneName);
    this._groups.delete(zoneName);

    // Clean up adjacency entries that reference this zone
    for (const [key, val] of this._adjacency) {
      if (val === zoneName || key.endsWith(`:${zoneName}`)) this._adjacency.delete(key);
    }

    if (newActive === null) {
      // Group is now empty — remove it
      group.node.remove();
      if (this._activeZoneName === zoneName) {
        this._setFocusedZone("main");
        this._zones.get("main")?.promptCollection.focus();
      }
    } else if (this._activeZoneName === zoneName) {
      this._setFocusedZone(newActive);
    }

    this._updateMultiLayout();
  }

  // Create a Zone inside a brand-new ZoneGroup, inserting the group into the container.
  _createZoneInNewGroup(name, insertBefore) {
    const group = new ZoneGroup();
    group.onActivate = (zoneName) => { this._setFocusedZone(zoneName); };
    this._container.insertBefore(group.node, insertBefore ?? null);
    this._initZone(name, group);
    this._updateMultiLayout();
    return this._zones.get(name);
  }

  // Create a Zone inside an existing ZoneGroup (new tab).
  _createZoneInGroup(name, group) {
    this._initZone(name, group);
    return this._zones.get(name);
  }

  _initZone(name, group) {
    const zone = new Zone(name, this._bridge);
    zone.promptCollection.onFocus = () => { this._setFocusedZone(name); };
    zone.promptCollection.onPromptsChanged = () => { this.removeZoneIfEmpty(name); };
    group.addZone(zone);
    zone.initBuffer();
    zone.startResizeTracking(this._charWidth, this._cellPadding, (zoneName, cols) => {
      this._bridge.sendCommand({ type: "resize", zone: zoneName, cols });
    });
    // Watch the buffer: remove zone when it becomes empty
    new MutationObserver(() => { this.removeZoneIfEmpty(name); })
      .observe(zone.buffer, { childList: true });
    this._zones.set(name, zone);
    this._groups.set(name, group);
  }

  allZones() {
    return this._zones.values();
  }

  // Resolve a descriptor to a Zone, creating if needed.
  // descriptor: string | {base, left?} | {base, right?} | {base, newTab: true}
  resolveZone(descriptor) {
    return this._zones.get(this.resolveZoneName(descriptor));
  }

  resolveZoneName(descriptor) {
    if (!descriptor || descriptor === "main") return "main";
    if (typeof descriptor === "string") {
      if (!this._zones.has(descriptor)) this._createZoneInNewGroup(descriptor, null);
      return descriptor;
    }

    const { base, left, right, newTab } = descriptor;

    if (newTab) {
      // If the shell stamped an ID, reuse the same zone for all messages in
      // that command (cell_create + prompt_create share the same descriptor).
      // Include base in the key so that left-zone tab-0 and right-zone tab-0
      // don't collide (each sub-shell process resets its own counter to 0).
      const cacheKey = descriptor.id != null ? `newTab:${base}:${descriptor.id}` : null;
      if (cacheKey && this._adjacency.has(cacheKey)) {
        return this._adjacency.get(cacheKey);
      }
      const group = this._groups.get(base) ?? this._groups.get("main");
      const newName = `zone-${++_zoneCounter}`;
      if (cacheKey) this._adjacency.set(cacheKey, newName);
      this._createZoneInGroup(newName, group);
      group.activateLatest();
      return newName;
    }

    const direction = left !== undefined ? "left" : "right";
    const key = `${direction}:${base}`;
    if (this._adjacency.has(key)) return this._adjacency.get(key);

    const newName = `zone-${++_zoneCounter}`;
    this._adjacency.set(key, newName);
    const reverse = direction === "left" ? "right" : "left";
    this._adjacency.set(`${reverse}:${newName}`, base);

    // Insert next to base's ZoneGroup node (not the zone node directly)
    const baseGroupNode = this._groups.get(base)?.node ?? null;
    const insertBefore = direction === "left" ? baseGroupNode : baseGroupNode?.nextSibling ?? null;
    this._createZoneInNewGroup(newName, insertBefore);
    return newName;
  }

  // ── Prompt delegation ──────────────────────────────────────────────────

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
    // Make the zone's tab active in its group (in case it's a hidden tab)
    this._groups.get(zone.name)?.activateByName(zone.name);
    // If zone has no prompts, fall back to main
    if (zone.promptCollection._prompts.length === 0 && zone.name !== "main") {
      this._zones.get("main")?.promptCollection.focus();
    } else {
      zone.promptCollection.focus();
    }
  }

  // Cycle to the next (+1) or previous (-1) tab across all zones, left-to-right.
  cycleTab(delta) {
    // Build flat ordered list: groups in DOM order, zones in tab order within each group.
    const seen = new Set();
    const all = []; // { zone, group }
    for (const groupNode of this._container.children) {
      for (const group of this._groups.values()) {
        if (group.node === groupNode && !seen.has(group)) {
          seen.add(group);
          for (const zone of group._zones) all.push({ zone, group });
          break;
        }
      }
    }
    if (all.length < 2) return;

    let currentIdx = all.findIndex(({ zone }) => zone.name === this._activeZoneName);
    if (currentIdx === -1) currentIdx = 0;

    const { zone, group } = all[(currentIdx + delta + all.length) % all.length];
    group.activateByName(zone.name);
  }
}
