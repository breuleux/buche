import { PromptCollection, setMoveToGroupHandler } from "./prompt.js";
import { html } from "./utils.js";

let _zoneCounter = 0;

export class Zone {
  constructor(name, bridge) {
    this.name = name;
    this._latentCellNode = null;
    this._latentFocusIsPrompt = false;
    this._soloCellNode = null;
    this.onSoloChanged = null; // (isSolo: bool, metaEl: Element|null) => void

    this.buffer = document.createElement("div");
    this.buffer.className = "zone-buffer";

    // Track the last focused .cell node within this zone's buffer.
    this.buffer.addEventListener("focusin", (e) => {
      const cell = e.target.closest(".cell");
      if (cell) {
        this._latentCellNode = cell;
        this._latentFocusIsPrompt = false;
      }
    });

    this._bufferWrap = document.createElement("scroll-fader");
    this._bufferWrap.classList.add("zone-buffer-wrap");

    this._inputContainer = document.createElement("div");
    this._inputContainer.className = "zone-input-container";

    this._inputArea = document.createElement("div");
    this._inputArea.className = "zone-input-area";
    this._inputArea.appendChild(this._inputContainer);

    this.node = document.createElement("div");
    this.node.className = "zone";
    this.node.dataset.zone = name;
    this.node.appendChild(this._bufferWrap);
    this.node.appendChild(this._inputArea);

    // PromptCollection inserts its tab bar after _inputContainer (still inside zone node)
    this.promptCollection = new PromptCollection(this._inputContainer, bridge, name);
  }

  // Lazily create a float container between the buffer and the input.
  getFloatContainer() {
    if (!this._floatContainer) {
      this._floatContainer = document.createElement("div");
      this._floatContainer.className = "zone-float-container";
      this._floatContainer.style.display = "none";
      this._inputArea.insertBefore(this._floatContainer, this._inputContainer);
    }
    return this._floatContainer;
  }

  // Must be called after zone.node is connected to the DOM.
  initBuffer() {
    this._bufferWrap.inner.appendChild(this.buffer);
    if (this.name !== "main") {
      new MutationObserver(() => {
        const isSolo = this.buffer.children.length === 1;
        this.node.classList.toggle("zone-solo-cell", isSolo);
        if (isSolo && !this._soloCellNode) {
          const cellNode = this.buffer.children[0];
          if (cellNode?._metaEl) {
            this._soloCellNode = cellNode;
            this.onSoloChanged?.(true, cellNode);
          }
        } else if (!isSolo && this._soloCellNode) {
          const prev = this._soloCellNode;
          this._soloCellNode = null;
          this.onSoloChanged?.(false, prev);
        }
      }).observe(this.buffer, { childList: true });
    }
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

  // Focus the zone: restore the last focused cell, or fall back to the prompt.
  focusLatent() {
    if (!this._latentFocusIsPrompt) {
      const node = this._latentCellNode;
      if (node?.isConnected && this.buffer.contains(node) && node._bucheFocus) {
        node.focus();
        node._bucheFocus();
        return;
      }
    }
    this._latentCellNode = null;
    this._latentFocusIsPrompt = false;
    this.promptCollection.focus();
  }

  focus() {
    this.focusLatent();
  }
}

// ── ZoneGroup ──────────────────────────────────────────────────────────────
// Wraps one or more Zones and shows a top tab bar when there are 2+ tabs.

class ZoneGroup {
  constructor() {
    this._zones = [];
    this._activeIdx = 0;
    this._tabEls = new Map(); // zoneName → <button>
    this._tabLabelEls = new Map(); // zoneName → <span class="tab-label">
    this._tabDefaultLabels = new Map(); // zoneName → default label string
    this._soloZones = new Set(); // zones currently in solo mode
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

  // Track per-zone solo state; show the tab bar strip if any zone is solo.
  setSoloActive(zoneName, active) {
    if (active) {
      this._soloZones.add(zoneName);
    } else {
      this._soloZones.delete(zoneName);
    }
    this.node.classList.toggle("zone-solo-active", this._soloZones.size > 0);
  }

  setTabLabel(zoneName, text) {
    const span = this._tabLabelEls.get(zoneName);
    if (span) span.textContent = text;
  }

  getDefaultLabel(zoneName) {
    return this._tabDefaultLabels.get(zoneName) ?? "";
  }

  addZone(zone) {
    const n = this._zones.length + 1;
    const defaultLabel = `Tab ${n}`;
    const labelSpan = html`<span class="tab-label">${defaultLabel}</span>`;
    const tabEl = document.createElement("button");
    tabEl.className = "zone-top-tab";
    tabEl.appendChild(labelSpan);
    tabEl.addEventListener("click", () => this.activateByName(zone.name));
    this._tabLabelEls.set(zone.name, labelSpan);
    this._tabDefaultLabels.set(zone.name, defaultLabel);

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

    // Always focus after paint, restoring latent cell or falling back to prompt.
    requestAnimationFrame(() => {
      this._zones[idx].focusLatent();
    });
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
    this._tabLabelEls.delete(zoneName);
    this._tabDefaultLabels.delete(zoneName);
    this._soloZones.delete(zoneName);
    this.node.classList.toggle("zone-solo-active", this._soloZones.size > 0);
    this._zones.splice(idx, 1);

    if (this._zones.length === 0) return null;

    if (wasActive) {
      this._activeIdx = Math.max(0, idx - 1);
      const next = this._zones[this._activeIdx];
      next.node.classList.remove("zone-hidden");
      this._tabEls.get(next.name)?.classList.add("active");
      requestAnimationFrame(() => {
        next.promptCollection.layoutAll();
        next.focusLatent();
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

// ── FloatZone ──────────────────────────────────────────────────────────────
// A minimal zone that renders cells inside another zone's float container.
// No ZoneGroup, no prompts, no tabs.

class FloatZone {
  constructor(name, container) {
    this.name = name;
    this._container = container;
    this.buffer = document.createElement("div");
    this.buffer.className = "zone-buffer";
    // Stub so ZoneManager iteration methods (applyHighlight etc.) don't crash.
    this.promptCollection = {
      _prompts: [],
      focus() {},
      layoutAll() {},
      removePromptsByProcess() {},
      setPrompt() {},
      applyHighlight() {},
      applyComplete() {},
      applyHistoryNav() {},
      onFocus: null,
      onPromptsChanged: null,
    };
  }

  // Call before appending a cell so the container is visible when focus() runs.
  prepareForCell() {
    this._container.style.display = "";
  }
}

// ── ZoneManager ────────────────────────────────────────────────────────────

export class ZoneManager {
  constructor(container, bridge) {
    this._container = container;
    this._bridge = bridge;
    this._zones = new Map();  // zoneName → Zone
    this._groups = new Map(); // zoneName → ZoneGroup
    // Persistent adjacency for float zones: `float:${baseName}` → zone name
    this._adjacency = new Map();
    // Persistent group tracking for @left/@right: `${direction}:${base}` → ZoneGroup
    this._sideGroups = new Map();
    // Per-process zone caching: processId → zone name (so all events from one
    // @left/@right/@tab command land in the same zone without a counter in the runner)
    this._processZones = new Map();
    this._activeZoneName = "main";
    setMoveToGroupHandler((delta) => this.moveToGroup(delta));

    const ctx = document.createElement("canvas").getContext("2d");
    ctx.font = "13px Consolas, Menlo, monospace";
    this._charWidth = ctx.measureText("M").width;
    this._cellPadding = 16;

    this.onFloatBlur = null; // (zoneName, baseZoneName) => void

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
    this._syncDividers();
  }

  _syncDividers() {
    for (const el of this._container.querySelectorAll(".zone-divider")) el.remove();
    const groupNodes = [...this._container.querySelectorAll(":scope > .zone-group")];
    for (let i = 1; i < groupNodes.length; i++) {
      groupNodes[i].insertAdjacentElement("beforebegin", this._makeDivider(groupNodes[i - 1], groupNodes[i]));
    }
  }

  _makeDivider(leftGroup, rightGroup) {
    const divider = html`<div class="zone-divider"></div>`;

    divider.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      divider.setPointerCapture(e.pointerId);

      // Freeze all groups at their current pixel widths
      const groupNodes = [...this._container.querySelectorAll(":scope > .zone-group")];
      const startWidths = new Map(groupNodes.map(g => [g, g.getBoundingClientRect().width]));
      for (const [g, w] of startWidths) g.style.flex = `0 0 ${w}px`;

      const startX = e.clientX;
      const leftStart = startWidths.get(leftGroup);
      const rightStart = startWidths.get(rightGroup);
      divider.classList.add("dragging");

      const onPointerMove = (e) => {
        const delta = e.clientX - startX;
        leftGroup.style.flex = `0 0 ${Math.max(80, leftStart + delta)}px`;
        rightGroup.style.flex = `0 0 ${Math.max(80, rightStart - delta)}px`;
        for (const zone of this._zones.values()) zone.promptCollection.layoutAll();
      };

      const onPointerUp = () => {
        divider.removeEventListener("pointermove", onPointerMove);
        divider.removeEventListener("pointerup", onPointerUp);
        divider.removeEventListener("pointercancel", onPointerUp);
        divider.classList.remove("dragging");
      };

      divider.addEventListener("pointermove", onPointerMove);
      divider.addEventListener("pointerup", onPointerUp);
      divider.addEventListener("pointercancel", onPointerUp);
    });

    return divider;
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
      // Group is now empty — remove it and reset sibling flex so they redistribute
      group.node.remove();
      // Clean up _sideGroups if this group was a left/right side group
      for (const [key, g] of this._sideGroups) {
        if (g === group) { this._sideGroups.delete(key); break; }
      }
      for (const el of this._container.querySelectorAll(":scope > .zone-group")) {
        el.style.flex = "";
      }
      if (this._activeZoneName === zoneName) {
        this._setFocusedZone("main");
        this._zones.get("main")?.focusLatent();
      }
    } else if (this._activeZoneName === zoneName) {
      this._setFocusedZone(newActive);
      this._zones.get(newActive)?.focusLatent();
    }

    this._updateMultiLayout();
  }

  // Create a FloatZone anchored to a base zone's float container.
  _createFloatZone(name, baseZoneName) {
    const baseZone = this._zones.get(baseZoneName) ?? this._zones.get("main");
    const container = baseZone.getFloatContainer();
    const zone = new FloatZone(name, container);
    container.appendChild(zone.buffer);

    // Show/hide the container based on whether the buffer has cells.
    new MutationObserver(() => {
      container.style.display = zone.buffer.children.length > 0 ? "" : "none";
    }).observe(zone.buffer, { childList: true });

    const triggerBlur = () => this.onFloatBlur?.(name, baseZoneName);

    // focusout handles non-iframe focus changes and process-close blur.
    container.addEventListener("focusout", (e) => {
      if (e.relatedTarget) {
        if (!container.contains(e.relatedTarget)) triggerBlur();
        return;
      }
      // relatedTarget is null: could be process close or iframe focus-in.
      // Wait a microtask for document.activeElement to settle.
      Promise.resolve().then(() => {
        if (!container.contains(document.activeElement)) triggerBlur();
      });
    });

    // focusin (capture) catches programmatic focus and keyboard navigation,
    // including when focus moves to the prompt via editor.focus().
    // mousedown (capture) catches clicks from inside iframes where focusin
    // may not cross the iframe boundary into the parent frame.
    const onOutside = (e) => {
      if (zone.buffer.children.length > 0 && !container.contains(e.target)) {
        triggerBlur();
      }
    };
    document.addEventListener("focusin", onOutside, true);
    document.addEventListener("mousedown", onOutside, true);

    // ESC closes the float and returns focus to the base zone.
    container.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.onFloatBlur?.(name, baseZoneName);
      }
    });

    this._zones.set(name, zone);
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
    zone.promptCollection.onFocus = () => {
      zone._latentFocusIsPrompt = true;
      this._setFocusedZone(name);
      if (!zone._soloCellNode) {
        const n = zone.promptCollection.activeName;
        if (n) group.setTabLabel(name, n);
      }
    };
    zone.promptCollection.onActiveChanged = (promptName) => {
      if (!zone._soloCellNode) {
        group.setTabLabel(name, promptName ?? group.getDefaultLabel(name));
      }
    };
    zone.promptCollection.onPromptsChanged = () => { this.removeZoneIfEmpty(name); };
    zone.onSoloChanged = (isSolo, cellNode) => {
      const tabEl = group.tabEl(name);
      if (isSolo && cellNode && tabEl) {
        // Dot goes to the far left, controls to the far right.
        if (cellNode._statusDot) tabEl.prepend(cellNode._statusDot);
        if (cellNode._controls) tabEl.appendChild(cellNode._controls);
        group.setTabLabel(name, cellNode._cellLabel ?? "");
      } else if (!isSolo && cellNode) {
        // Reassemble back into _metaEl (which stays in the cell as a parking spot).
        const metaEl = cellNode._metaEl;
        if (cellNode._statusDot) metaEl.prepend(cellNode._statusDot);
        if (cellNode._controls) metaEl.appendChild(cellNode._controls);
        group.setTabLabel(name, zone.promptCollection.activeName ?? group.getDefaultLabel(name));
      }
      group.setSoloActive(name, isSolo);
    };
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
  // processId: the outermost process ID from the instruction's address (optional).
  //   Used to route all events from one @left/@right/@tab command to the same zone.
  resolveZone(descriptor, processId) {
    return this._zones.get(this.resolveZoneName(descriptor, processId));
  }

  resolveZoneName(descriptor, processId) {
    if (!descriptor || descriptor === "main") return "main";
    if (typeof descriptor === "string") {
      if (!this._zones.has(descriptor)) this._createZoneInNewGroup(descriptor, null);
      return descriptor;
    }

    // Per-process caching: all events (cell_create, prompt_create) from the same
    // processId share a zone, so @left foo creates one zone regardless of how many
    // events the subprocess emits.
    if (processId && this._processZones.has(processId)) {
      return this._processZones.get(processId);
    }

    const { base, left, newTab, float } = descriptor;

    if (float) {
      const cacheKey = `float:${base}`;
      if (this._adjacency.has(cacheKey)) return this._adjacency.get(cacheKey);
      const newName = `zone-${++_zoneCounter}`;
      this._adjacency.set(cacheKey, newName);
      this._createFloatZone(newName, base);
      if (processId) this._processZones.set(processId, newName);
      return newName;
    }

    const newName = `zone-${++_zoneCounter}`;

    if (newTab) {
      const group = this._groups.get(base) ?? this._groups.get("main");
      this._createZoneInGroup(newName, group);
      group.activateLatest();
    } else {
      // @left or @right: create a new tab in the adjacent group (creating the
      // group itself on first use).
      const direction = left !== undefined ? "left" : "right";

      // If base is itself in a side group, use that group directly rather than
      // creating another column. This handles @left from within a left-side zone.
      const baseGroup = this._groups.get(base);
      let sideKey = `${direction}:${base}`;
      let group = this._sideGroups.get(sideKey);

      if (!group && baseGroup) {
        for (const [key, g] of this._sideGroups) {
          if (g === baseGroup) { sideKey = key; group = g; break; }
        }
      }

      if (!group) {
        group = new ZoneGroup();
        group.onActivate = (zoneName) => { this._setFocusedZone(zoneName); };
        const baseGroupNode = baseGroup?.node ?? null;
        const insertBefore = direction === "left" ? baseGroupNode : baseGroupNode?.nextSibling ?? null;
        this._container.insertBefore(group.node, insertBefore ?? null);
        this._sideGroups.set(sideKey, group);
        this._updateMultiLayout();
      }

      this._initZone(newName, group);
      group.activateLatest();
    }

    if (processId) this._processZones.set(processId, newName);
    return newName;
  }

  // ── Prompt delegation ──────────────────────────────────────────────────

  addPrompt(instruction) {
    const processId = instruction.address?.process;
    const zone = this.resolveZone(instruction.zone ?? "main", processId);
    zone.promptCollection.addPrompt({ ...instruction, zone: zone.name });
    return zone.name;
  }

  removePromptsByProcess(process_id) {
    // Clean up processZones cache for root-level process closures.
    if (!process_id.includes("/")) {
      this._processZones.delete(process_id);
    }
    for (const [zoneName, zone] of this._zones) {
      const hadPrompts = zone.promptCollection._prompts.length > 0;
      zone.promptCollection.removePromptsByProcess(process_id);
      if (hadPrompts && zone.promptCollection._prompts.length === 0 && zoneName !== "main") {
        zone.buffer.replaceChildren();
        this.removeZoneIfEmpty(zoneName);
      }
    }
  }

  setPrompt(instruction) {
    for (const zone of this._zones.values()) {
      zone.promptCollection.setPrompt(instruction);
    }
  }

  setInput(instruction) {
    for (const zone of this._zones.values()) {
      zone.promptCollection.setInput(instruction);
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

  applyHistoryNav(instruction) {
    for (const zone of this._zones.values()) {
      zone.promptCollection.applyHistoryNav(instruction);
    }
  }

  clearZoneBuffer(zoneName) {
    const zone = this._zones.get(zoneName);
    if (zone) zone.buffer.replaceChildren();
  }

  focusZone(zoneName) {
    const zone = this._zones.get(zoneName);
    // Zone may have been removed by removePromptsByProcess; removeZoneIfEmpty
    // already set focus in that case — don't override it.
    if (!zone) return;
    // Float zones (no group) manage their own focus via onFloatBlur — don't interfere.
    if (!this._groups.has(zone.name)) return;
    // Make the zone's tab active in its group (in case it's a hidden tab).
    // activateByName schedules a rAF for focus — do not call focus() synchronously
    // here, as it runs right after cell.node.blur() and is unreliable.
    this._groups.get(zone.name)?.activateByName(zone.name);
    // If zone has no prompts, fall back to main via rAF for the same reason.
    if (zone.promptCollection._prompts.length === 0 && zone.name !== "main") {
      requestAnimationFrame(() => this._zones.get("main")?.focusLatent());
    }
  }

  // Cycle to the next (+1) or previous (-1) tab within the current zone's group.
  cycleTab(delta) {
    this._groups.get(this._activeZoneName)?.cycleTab(delta);
  }

  // Move focus to the next (+1) or previous (-1) zone group in DOM order.
  moveToGroup(delta) {
    const groupNodes = [...this._container.querySelectorAll(":scope > .zone-group")];
    const currentGroup = this._groups.get(this._activeZoneName);
    const currentIdx = groupNodes.indexOf(currentGroup?.node ?? null);
    if (currentIdx === -1) return;
    const nextNode = groupNodes[currentIdx + delta];
    if (!nextNode) return;
    const seen = new Set();
    for (const group of this._groups.values()) {
      if (group.node === nextNode && !seen.has(group)) {
        seen.add(group);
        group.activateByName(group.activeZone.name);
        return;
      }
    }
  }
}
