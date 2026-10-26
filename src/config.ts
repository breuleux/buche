// Buche's configuration (YAML, see config/default.yaml): its `modifiers` and
// `bindings` sections, resolved into what the interface installs — modes,
// each one a carreau navigation mode (a modifier's chord, e.g. `Nav: Alt+q`,
// and its `Nav+…` bindings), and the always-live global chords
// (keybindings.ts).
//
// Reading the file (and copying the default over, or resetting the bindings)
// is the launcher's (scripts/user-config.ts): this module is pure, so the
// renderer can resolve the config it is handed, and report what's wrong in it.

import type { Modifier } from "carreau";

/** The configuration, as parsed from YAML. */
export interface BucheConfig {
    modifiers?: Record<string, unknown>;
    bindings?: Record<string, unknown>;
}

type Mod = "Shift" | "Alt" | "Ctrl" | "Meta";
type Side = "left" | "right" | "either";

/** Modifiers in carreau's canonical chord order. */
const MOD_ORDER: readonly Mod[] = ["Shift", "Alt", "Ctrl", "Meta"];

const MOD_NAMES: Record<string, Mod | "Mod"> = {
    ctrl: "Ctrl",
    control: "Ctrl",
    alt: "Alt",
    option: "Alt",
    opt: "Alt",
    shift: "Shift",
    meta: "Meta",
    cmd: "Meta",
    command: "Meta",
    super: "Meta",
    win: "Meta",
    mod: "Mod",
};

/** Carreau's name for a modifier (its `activation.modifier`). */
const CARREAU_MOD: Record<Mod, Modifier> = {
    Shift: "Shift",
    Alt: "Alt",
    Ctrl: "Control",
    Meta: "Meta",
};

/** Punctuation keys ↔ their `KeyboardEvent.code`. */
const PUNCTUATION: Record<string, string> = {
    "-": "Minus",
    "=": "Equal",
    "[": "BracketLeft",
    "]": "BracketRight",
    "\\": "Backslash",
    ";": "Semicolon",
    "'": "Quote",
    "`": "Backquote",
    ",": "Comma",
    ".": "Period",
    "/": "Slash",
};
const PUNCTUATION_CODES: Record<string, string> = Object.fromEntries(
    Object.entries(PUNCTUATION).map(([ch, code]) => [code, ch]),
);

/** Named keys (case-insensitive) → their code. */
const NAMED_KEYS: Record<string, string> = {
    left: "ArrowLeft",
    right: "ArrowRight",
    up: "ArrowUp",
    down: "ArrowDown",
    arrowleft: "ArrowLeft",
    arrowright: "ArrowRight",
    arrowup: "ArrowUp",
    arrowdown: "ArrowDown",
    enter: "Enter",
    return: "Enter",
    tab: "Tab",
    space: "Space",
    esc: "Escape",
    escape: "Escape",
    backspace: "Backspace",
    delete: "Delete",
    del: "Delete",
    insert: "Insert",
    home: "Home",
    end: "End",
    pageup: "PageUp",
    pagedown: "PageDown",
};

/** A parsed chord: its modifiers and its key (a `KeyboardEvent.code`). */
interface Chord {
    mods: Set<Mod>;
    code: string;
    /** For a single modifier restricted to one side (AltLeft+q). */
    side: Side;
}

/** The `KeyboardEvent.code` of a key as written in the config. */
function keyCode(token: string): string | null {
    if (/^[a-z]$/i.test(token)) {
        return `Key${token.toUpperCase()}`;
    }
    if (/^[0-9]$/.test(token)) {
        return `Digit${token}`;
    }
    if (token in PUNCTUATION) {
        return PUNCTUATION[token];
    }
    const named = NAMED_KEYS[token.toLowerCase()];
    if (named) {
        return named;
    }
    if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(token)) {
        return token.toUpperCase();
    }
    // A code, as is (KeyQ, Digit1, Comma, Numpad1, ...).
    if (/^(Key[A-Z]|Digit[0-9]|Numpad\w+)$/.test(token) || token in PUNCTUATION_CODES) {
        return token;
    }
    return null;
}

/** The key (as keychord.ts names it, i.e. `KeyboardEvent.key`) of a code. */
function codeKey(code: string): string {
    const m = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(code);
    if (m) {
        return (m[1] ?? m[2]).toLowerCase();
    }
    return PUNCTUATION_CODES[code] ?? (code === "Space" ? "space" : code);
}

/** Parse a chord like "Ctrl+Shift+Tab". Throws (a message) if malformed. */
function parseChord(text: string, mac: boolean): Chord {
    const tokens = text.split("+").map((t) => t.trim());
    const keyToken = tokens.pop() ?? "";
    const mods = new Set<Mod>();
    let side: Side = "either";
    for (const token of tokens) {
        const m = /^(?:(left|right)?([a-z]+?)(left|right)?)$/i.exec(token);
        const name = m && MOD_NAMES[m[2].toLowerCase()];
        if (!m || !name || (m[1] && m[3])) {
            throw new Error(`"${token}" is not a modifier (define it under modifiers:)`);
        }
        const mod = name === "Mod" ? (mac ? "Meta" : "Ctrl") : name;
        const s = (m[1] ?? m[3])?.toLowerCase() as Side | undefined;
        if (s) {
            side = s;
        }
        mods.add(mod);
    }
    if (!keyToken) {
        throw new Error("no key");
    }
    if (MOD_NAMES[keyToken.toLowerCase()]) {
        throw new Error(`the key is missing (${keyToken} is a modifier)`);
    }
    const code = keyCode(keyToken);
    if (!code) {
        throw new Error(`"${keyToken}" is not a key`);
    }
    return { mods, code, side };
}

/** A chord in carreau's syntax (modifiers in order, the key by its code). */
function carreauChord(c: Chord): string {
    return [...MOD_ORDER.filter((m) => c.mods.has(m)), c.code].join("+");
}

/** A chord in keychord.ts's syntax (the key by its name). */
function keyChord(c: Chord): string {
    return [...MOD_ORDER.filter((m) => c.mods.has(m)), codeKey(c.code)].join("+");
}

// ── Actions ───────────────────────────────────────────────────────────────────

const DIRS = ["Left", "Right", "Up", "Down"] as const;

/** Global actions: see BucheInterface.installKeys. */
export const GLOBAL_ACTIONS = [
    "focusPrompt",
    "clearPrompt",
    "nextTab",
    "prevTab",
    "closeTab",
    "kill",
    "renameWindow",
] as const;
export type GlobalAction = (typeof GLOBAL_ACTIONS)[number];

/** Navigation-mode actions buche implements itself (see navConfig). */
export const BUCHE_NAV_ACTIONS = [
    "kill",
    "focusPrompt",
    "renameWindow",
    "insert",
    "insertInto",
    "insertFloat",
    ...DIRS.map((d) => `insert${d}`),
    ...DIRS.map((d) => `insertInto${d}`),
];

/** Navigation-mode actions carreau implements (its NavAction). */
const CARREAU_NAV_ACTIONS = [
    "nextTab",
    "prevTab",
    "parent",
    "root",
    "child",
    "undo",
    "redo",
    "unexpand",
    "maximize",
    "restore",
    "toggleMaximize",
    "float",
    "closeTab",
    "closePane",
    "forceCloseTab",
    "group",
    "collapse",
    "renameTab",
    "namePane",
    "mark",
    "moveMarked",
    "clear",
    "growWidth",
    "shrinkWidth",
    "growHeight",
    "shrinkHeight",
    ...["focus", "expand", "swap", "move", "moveInto"].flatMap((a) => DIRS.map((d) => a + d)),
];

const NAV_ACTIONS = new Set([...BUCHE_NAV_ACTIONS, ...CARREAU_NAV_ACTIONS]);

// ── Resolution ────────────────────────────────────────────────────────────────

/**
 * A mode: entered with its chord (a modifier plus a key), it lasts while the
 * modifier is held (or, the key pressed again, until it is left); its own
 * bindings and prefixes then apply. (Carreau's navigation mode: NavConfig.)
 */
export interface Mode {
    modifier: Modifier;
    code: string;
    side: Side;
    /** The chord in keychord.ts's syntax (for GUI iframes to hand it over). */
    chord: string;
    /** Bindings: carreau chord → action name. */
    bindings: Record<string, string>;
    /** Prefixes: carreau chord → (carreau chord → action). */
    prefixes: Record<string, Record<string, string>>;
}

/** The bindings, ready to install. */
export interface Bindings {
    /** The modes, by name (Nav, ...), in the config's order. */
    modes: Record<string, Mode>;
    /** Global bindings: keychord.ts chord → action. */
    global: Record<string, GlobalAction>;
}

/** Used when the config defines no (valid) modifier at all. */
const FALLBACK_MODIFIERS = { Nav: "Alt+q" };

const isTable = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);

/** Two activation chords that one key press could both match. */
const overlaps = (a: Mode, b: Mode): boolean =>
    a.modifier === b.modifier &&
    a.code === b.code &&
    (a.side === b.side || a.side === "either" || b.side === "either");

/**
 * Resolve configs' modifiers and bindings: layers (the defaults, then the
 * user's), each one over the ones before it. Entries are taken in order, the
 * layers' one after the other, the last one for a chord winning: a binding
 * goes by its chord, however it's written (`Nav+,` and `Nav+Comma` are the
 * same: whichever comes last wins), a modifier by its name; a prefix's table
 * is merged key by key. `~` (null) removes what came before (a modifier: its
 * mode, and its bindings).
 *
 * What is wrong is reported in `errors` and left out (no valid modifier at
 * all: Nav: Alt+q), so that a mistake never leaves the user without a way to
 * navigate. `mac`: whether `Mod` means Cmd (else Ctrl).
 */
export function resolveBindings(
    layers: (BucheConfig | null | undefined)[],
    mac: boolean,
): { bindings: Bindings; errors: string[] } {
    const errors: string[] = [];
    // Each layer's entries of a section, with where they come from (the
    // layers below the last one are the defaults).
    const entries = (section: "modifiers" | "bindings") =>
        layers.flatMap((config, i) => {
            const origin = i < layers.length - 1 ? " (in the defaults)" : "";
            const spec = config?.[section];
            if (spec === undefined || spec === null) {
                return [];
            }
            if (!isTable(spec)) {
                errors.push(`${section}: expected a table${origin}`);
                return [];
            }
            return Object.entries(spec).map(([key, value]) => ({ key, value, origin }));
        });

    // The modes first: the bindings are by mode. A layer's modifier replaces
    // the same name's below it (in its place: the first mode stays first).
    const defined = new Map<string, { value: unknown; origin: string }>();
    for (const { key, value, origin } of entries("modifiers")) {
        defined.set(key, { value, origin });
    }
    /** Modifiers removed (`~`): their bindings go silently. */
    const removed = new Set([...defined].filter(([, d]) => d.value === null).map(([n]) => n));
    const modes: Record<string, Mode> = {};
    const defineModes = (list: [string, unknown, string][], report: string[]) => {
        for (const [name, value, origin] of list) {
            const where = `modifiers: ${name}`;
            if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
                report.push(`${where}: a modifier's name is a word (e.g. Nav)${origin}`);
            } else if (MOD_NAMES[name.toLowerCase()] || /(left|right)$/i.test(name)) {
                report.push(`${where}: that name is a keyboard modifier's${origin}`);
            } else if (value !== null) {
                const mode = resolveMode(value, mac);
                const clash = Object.entries(modes).find(
                    ([, m]) => typeof mode !== "string" && overlaps(m, mode),
                );
                if (typeof mode === "string") {
                    report.push(`${where}: ${mode}${origin}`);
                } else if (clash) {
                    report.push(`${where}: same chord as ${clash[0]}${origin}`);
                } else {
                    modes[name] = mode;
                }
            }
        }
    };
    defineModes(
        [...defined].map(([name, d]) => [name, d.value, d.origin]),
        errors,
    );
    if (Object.keys(modes).length === 0) {
        errors.push(`modifiers: none defined (using Nav: ${FALLBACK_MODIFIERS.Nav})`);
        defineModes([["Nav", FALLBACK_MODIFIERS.Nav, ""]], []);
    }
    const bindings: Bindings = { modes, global: {} };

    /** A chord in a mode (its modifier left out), or null. */
    const modeChord = (mode: Mode, where: string, text: string): string | null => {
        let chord: Chord;
        try {
            chord = parseChord(text, mac);
        } catch (e) {
            errors.push(`${where}: ${(e as Error).message}`);
            return null;
        }
        const mod = MOD_ORDER.find((m) => CARREAU_MOD[m] === mode.modifier) as Mod;
        if (chord.mods.has(mod)) {
            errors.push(`${where}: ${mod} is the mode's modifier: it can't be part of the chord`);
            return null;
        }
        return carreauChord(chord);
    };

    const modeAction = (where: string, value: unknown): string | null => {
        if (typeof value === "string" && NAV_ACTIONS.has(value)) {
            return value;
        }
        errors.push(`${where}: unknown navigation action ${JSON.stringify(value)}`);
        return null;
    };

    for (const { key, value, origin } of entries("bindings")) {
        const where = `bindings: ${key}`;
        const plus = key.indexOf("+");
        const modeName = plus > 0 ? key.slice(0, plus).trim() : "";
        if (removed.has(modeName)) {
            continue;
        }
        const mode = modes[modeName];
        if (mode) {
            const chord = modeChord(mode, where, key.slice(plus + 1));
            if (chord === null) {
                continue;
            }
            if (value === null) {
                delete mode.bindings[chord];
                delete mode.prefixes[chord];
                continue;
            }
            if (chord === mode.code) {
                errors.push(`${where}: this key toggles the mode, it can't be bound${origin}`);
                continue;
            }
            if (isTable(value)) {
                // (Merged into the table below, if any.)
                const prefix = mode.prefixes[chord] ?? {};
                for (const [k, v] of Object.entries(value)) {
                    const sub = modeChord(mode, `${where} ${k}`, k);
                    if (sub === null) {
                        continue;
                    }
                    if (v === null) {
                        delete prefix[sub];
                        continue;
                    }
                    const action = modeAction(`${where} ${k}`, v);
                    if (action) {
                        prefix[sub] = action;
                    }
                }
                delete mode.bindings[chord];
                mode.prefixes[chord] = prefix;
            } else {
                const action = modeAction(where, value);
                if (action) {
                    delete mode.prefixes[chord];
                    mode.bindings[chord] = action;
                }
            }
            continue;
        }
        let chord: Chord;
        try {
            chord = parseChord(key, mac);
        } catch (e) {
            // (A bare word: likely a mode's chord, out of place.)
            const hint = /^[A-Za-z]\w+$/.test(key)
                ? " (a modifier? define it under modifiers:)"
                : "";
            errors.push(`${where}: ${(e as Error).message}${hint}`);
            continue;
        }
        const name = keyChord(chord);
        if (value === null) {
            delete bindings.global[name];
            continue;
        }
        if (chord.side !== "either") {
            errors.push(`${where}: only a modifiers: chord can name the modifier's side`);
            continue;
        }
        // Global chords are live everywhere: without Ctrl, Alt or Cmd, they
        // would take keys away from typing (function keys aside).
        const typing = !["Ctrl", "Alt", "Meta"].some((m) => chord.mods.has(m as Mod));
        if (typing && !/^F\d+$/.test(chord.code)) {
            errors.push(`${where}: a global binding needs Ctrl, Alt or Cmd`);
            continue;
        }
        if (typeof value !== "string" || !(GLOBAL_ACTIONS as readonly string[]).includes(value)) {
            errors.push(`${where}: unknown global action ${JSON.stringify(value)}`);
            continue;
        }
        const entered = Object.keys(modes).find((n) => modes[n].chord === name);
        if (entered) {
            errors.push(`${where}: that chord enters the ${entered} mode${origin}`);
            continue;
        }
        bindings.global[name] = value as GlobalAction;
    }
    return { bindings, errors };
}

/** A mode, without bindings yet, from its chord; or what's wrong with it. */
function resolveMode(value: unknown, mac: boolean): Mode | string {
    if (typeof value !== "string") {
        return "expected a chord, e.g. Alt+q";
    }
    let chord: Chord;
    try {
        chord = parseChord(value, mac);
    } catch (e) {
        return (e as Error).message;
    }
    if (chord.mods.size !== 1) {
        return "it needs exactly one modifier (held for the mode to last), e.g. Alt+q";
    }
    const [mod] = chord.mods;
    return {
        modifier: CARREAU_MOD[mod],
        code: chord.code,
        side: chord.side,
        chord: keyChord(chord),
        bindings: {},
        prefixes: {},
    };
}
