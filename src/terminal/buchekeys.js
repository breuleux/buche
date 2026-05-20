import { tinykeys } from "tinykeys";

const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.platform);

/**
 * Parse a tinykeys-style combo string (e.g. "Control+Alt+k") into a
 * structured descriptor used for manual matching.
 * $mod resolves to Meta on Mac and Control elsewhere (matching tinykeys behaviour).
 */
function parseCombo(combo) {
  const parts = combo.split("+");
  const key = parts.pop();
  const mods = new Set(parts.map((m) => m.toLowerCase()));
  const hasMod = mods.has("$mod");
  return {
    key,
    ctrl: mods.has("control") || (hasMod && !isMac),
    shift: mods.has("shift"),
    alt: mods.has("alt"),
    meta: mods.has("meta") || (hasMod && isMac),
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
export function buchekeys(element, bindings, { prefixTimeout = 500, capture = false } = {}) {
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

  const makePrefixHandler = (subEntries) => (e) => {
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

  for (const [prefix, subEntries] of prefixGroups) {
    normalBindings[prefix] = makePrefixHandler(subEntries);
  }

  if (capture) {
    // Use tinykeys with capture:true, wrapping each handler to stop propagation
    // so matched events never reach child elements.
    const captureBindings = Object.fromEntries(
      Object.entries(normalBindings).map(([combo, handler]) => [
        combo,
        (e) => { e.stopPropagation(); handler(e); },
      ])
    );
    const unsubscribe = tinykeys(element, captureBindings, { capture: true });

    // Build a descriptor for iframe key-forwarding.
    const toProps = ({ key, ctrl, shift, alt, meta }) =>
      ({ key, ctrlKey: ctrl, shiftKey: shift, altKey: alt, metaKey: meta });
    const prefixTriggerSet = new Set(prefixGroups.keys());
    const config = {
      globalKeys: Object.keys(normalBindings)
        .filter(combo => !prefixTriggerSet.has(combo))
        .map(combo => toProps(parseCombo(combo))),
      prefixKeys: [...prefixGroups.keys()].map(prefix => ({
        ...toProps(parseCombo(prefix)),
        timeout: prefixTimeout,
      })),
    };

    return { unsubscribe, config };
  }

  return tinykeys(element, normalBindings);
}
