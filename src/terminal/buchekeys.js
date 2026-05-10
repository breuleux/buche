import { tinykeys } from "tinykeys";

/**
 * Parse a tinykeys-style combo string (e.g. "Control+Alt+k") into a
 * structured descriptor used for manual matching.
 */
function parseCombo(combo) {
  const parts = combo.split("+");
  const key = parts.pop();
  const mods = new Set(parts.map((m) => m.toLowerCase()));
  return {
    key,
    ctrl: mods.has("control"),
    shift: mods.has("shift"),
    alt: mods.has("alt"),
    meta: mods.has("meta") || mods.has("$mod"),
  };
}

function matchesCombo(e, parsed) {
  return (
    e.key === parsed.key &&
    e.ctrlKey === parsed.ctrl &&
    e.shiftKey === parsed.shift &&
    e.altKey === parsed.alt &&
    e.metaKey === parsed.meta
  );
}

/**
 * Wrapper around tinykeys with prefix-mode support.
 *
 * Bindings whose key contains " ~ " are treated as prefix sequences:
 *   "Control+q ~ ArrowUp"  →  press Control+q, then ArrowUp within prefixTimeout ms.
 *
 * After the prefix key fires the element enters prefix mode: a capturing
 * keydown listener intercepts the next non-modifier key, runs the matching
 * handler (stopping propagation), or cancels mode if no match. Mode also
 * cancels on timeout.
 *
 * @param {EventTarget} element
 * @param {Record<string, (e: KeyboardEvent) => void>} bindings
 * @param {{ prefixTimeout?: number }} options
 * @returns {() => void} unsubscribe function
 */
export function buchekeys(element, bindings, { prefixTimeout = 500 } = {}) {
  const normalBindings = {};
  // prefix string → Array<{ parsed, handler }>
  const prefixGroups = new Map();

  for (const [key, handler] of Object.entries(bindings)) {
    const sep = key.indexOf(" ~ ");
    if (sep !== -1) {
      const prefix = key.slice(0, sep).trim();
      const subKey = key.slice(sep + 3).trim();
      if (!prefixGroups.has(prefix)) prefixGroups.set(prefix, []);
      prefixGroups.get(prefix).push({ parsed: parseCombo(subKey), handler });
    } else {
      normalBindings[key] = handler;
    }
  }

  for (const [prefix, subEntries] of prefixGroups) {
    normalBindings[prefix] = (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();

      let timeoutId = null;

      const cleanup = () => {
        clearTimeout(timeoutId);
        element.removeEventListener("keydown", onSubKey, true);
      };

      const onSubKey = (evt) => {
        // Let modifier-only keypresses pass through without cancelling mode.
        if (["Control", "Shift", "Alt", "Meta"].includes(evt.key)) return;

        for (const { parsed, handler } of subEntries) {
          if (matchesCombo(evt, parsed)) {
            // Stay in prefix mode — reset the timeout.
            clearTimeout(timeoutId);
            timeoutId = setTimeout(cleanup, prefixTimeout);
            evt.preventDefault();
            evt.stopImmediatePropagation();
            handler(evt);
            return;
          }
        }
        // Unrecognised key — cancel mode, let the event propagate normally.
        cleanup();
      };

      element.addEventListener("keydown", onSubKey, true);
    };
  }

  return tinykeys(element, normalBindings);
}
