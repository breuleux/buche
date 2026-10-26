// Buche's configuration (YAML, see config/default.yaml). Its `bindings` are
// a list of rules, as VS Code's keybindings: a key (a chord, or a sequence of
// them: "i enter"), an action, and optionally a condition (`when`) and the
// action's arguments (`args`). Layers (the defaults, then the user's) are
// concatenated; on a key press, the last rule for it whose condition holds
// wins (see keymap.ts). `action: -name` removes the rules before it for that
// action (and key, and condition, if given).
//
// Modes are entered with the `setMode` action: e.g. `{ key: alt+q, action:
// setMode, args: { mode: nav, hold: alt } }` enters the `nav` mode, which
// lasts while Alt is held (pressing Q again makes it last until it is left:
// `sticky: repeat`, the default; or `never`). In a mode, the layout is in
// carreau's navigation mode, and the mode's modifier is left out of chords:
// `{ key: left, action: focusLeft, when: mode == nav }` is Alt+Left, or Left.
//
// Conditions: `mode` (the mode on, "" if none), `inPrompt`, `inPTY` (an
// embedded terminal), `inFrame` (a GUI cell's iframe); with `==`, `!=`, `!`,
// `&&`, `||` and parentheses. Inside GUI iframes, only the rules that can
// apply there (see `frameChords`) take keys from the page in the iframe.
//
// Reading the file is the launcher's (scripts/user-config.ts): this module is
// pure, so the renderer can resolve the config it is handed, and report
// what's wrong in it.

import type { Modifier } from "carreau";

/** The configuration, as parsed from YAML. */
export interface BucheConfig {
    bindings?: unknown;
}

export type Mod = "Shift" | "Alt" | "Ctrl" | "Meta";
export type Side = "left" | "right" | "either";

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
export const CARREAU_MOD: Record<Mod, Modifier> = {
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
            throw new Error(`"${token}" is not a modifier`);
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

/** A chord in the canonical form: modifiers in order, then the key's code. */
function chordString(mods: Iterable<Mod>, code: string): string {
    const set = new Set(mods);
    return [...MOD_ORDER.filter((m) => set.has(m)), code].join("+");
}

/**
 * A chord as written (e.g. "Mod+p", "alt+,", "Alt+KeyQ") in the canonical
 * form ("Meta+KeyP", "Alt+Comma", "Alt+KeyQ"); null if it isn't one.
 */
export function canonicalChord(text: string, mac: boolean): string | null {
    try {
        const chord = parseChord(text, mac);
        return chordString(chord.mods, chord.code);
    } catch {
        return null;
    }
}

const MOD_FLAGS: [Mod, "shiftKey" | "altKey" | "ctrlKey" | "metaKey"][] = [
    ["Shift", "shiftKey"],
    ["Alt", "altKey"],
    ["Ctrl", "ctrlKey"],
    ["Meta", "metaKey"],
];

/**
 * The chords a key event can stand for, in the canonical form: by its
 * physical key (`code`) first, then by the key it types (other keyboard
 * layouts). `strip`: a modifier left out (a mode's).
 */
export function eventChords(
    e: Pick<KeyboardEvent, "code" | "key" | "shiftKey" | "altKey" | "ctrlKey" | "metaKey">,
    strip?: Mod,
): string[] {
    const mods = MOD_FLAGS.filter(([m, flag]) => e[flag] && m !== strip).map(([m]) => m);
    const chords = e.code ? [chordString(mods, e.code)] : [];
    const typed =
        e.key === " "
            ? "Space"
            : e.key.length === 1
              ? keyCode(e.key)
              : (NAMED_KEYS[e.key.toLowerCase()] ?? e.key);
    if (typed) {
        const byKey = chordString(mods, typed);
        if (!chords.includes(byKey)) {
            chords.push(byKey);
        }
    }
    return chords;
}

// ── Conditions ────────────────────────────────────────────────────────────────

/** What conditions are evaluated on. */
export interface Context {
    /** The mode on ("" if none). */
    mode: string;
    inPrompt: boolean;
    inPTY: boolean;
    inFrame: boolean;
}

const CONTEXT_KEYS = new Set(["mode", "inPrompt", "inPTY", "inFrame"]);

/** A parsed condition. */
export interface Condition {
    text: string;
    test: (ctx: Context) => boolean;
    /** Whether it depends on `mode`, and the modes it names. */
    usesMode: boolean;
    modes: string[];
}

/** Parse a `when` condition. Throws (a message) if malformed. */
export function parseCondition(text: string): Condition {
    const tokens =
        text.match(/\s*(==|!=|&&|\|\||!|\(|\)|'[^']*'|"[^"]*"|[A-Za-z_][\w.-]*|\S)/g) ?? [];
    const toks = tokens.map((t) => t.trim());
    let i = 0;
    let usesMode = false;
    const modes: string[] = [];
    const peek = () => toks[i];
    const expect = (t: string) => {
        if (toks[i] !== t) {
            throw new Error(`expected ${t}${toks[i] ? ` at "${toks[i]}"` : " at the end"}`);
        }
        i++;
    };
    type Test = (ctx: Context) => boolean;
    const value = (): string => {
        const t = toks[i++];
        if (t === undefined) {
            throw new Error("expected a value at the end");
        }
        if (/^['"]/.test(t)) {
            return t.slice(1, -1);
        }
        if (!/^[A-Za-z_]/.test(t)) {
            throw new Error(`expected a value at "${t}"`);
        }
        return t;
    };
    const primary = (): Test => {
        const t = peek();
        if (t === "(") {
            i++;
            const inner = or();
            expect(")");
            return inner;
        }
        if (t === undefined || !/^[A-Za-z_]/.test(t)) {
            throw new Error(t === undefined ? "unexpected end" : `unexpected "${t}"`);
        }
        i++;
        if (!CONTEXT_KEYS.has(t)) {
            throw new Error(`unknown context "${t}" (known: ${[...CONTEXT_KEYS].join(", ")})`);
        }
        const key = t as keyof Context;
        if (key === "mode") {
            usesMode = true;
        }
        const op = peek();
        if (op === "==" || op === "!=") {
            i++;
            const v = value();
            if (key === "mode") {
                modes.push(v);
            }
            return op === "==" ? (ctx) => String(ctx[key]) === v : (ctx) => String(ctx[key]) !== v;
        }
        return (ctx) => !!ctx[key];
    };
    const unary = (): Test => {
        if (peek() === "!") {
            i++;
            const inner = unary();
            return (ctx) => !inner(ctx);
        }
        return primary();
    };
    const and = (): Test => {
        let left = unary();
        while (peek() === "&&") {
            i++;
            const l = left;
            const r = unary();
            left = (ctx) => l(ctx) && r(ctx);
        }
        return left;
    };
    const or = (): Test => {
        let left = and();
        while (peek() === "||") {
            i++;
            const l = left;
            const r = and();
            left = (ctx) => l(ctx) || r(ctx);
        }
        return left;
    };
    const test = or();
    if (i < toks.length) {
        throw new Error(`unexpected "${toks[i]}"`);
    }
    return { text, test, usesMode, modes };
}

// ── Actions ───────────────────────────────────────────────────────────────────

const DIRS = ["Left", "Right", "Up", "Down"] as const;

/** Actions buche implements itself (see BucheInterface.runAction). */
export const BUCHE_ACTIONS = [
    "setMode",
    "leaveMode",
    "focusPrompt",
    "clearPrompt",
    "kill",
    "rerun",
    "renameWindow",
    "nextTab",
    "prevTab",
    "insert",
    "insertInto",
    "insertFloat",
    ...DIRS.map((d) => `insert${d}`),
    ...DIRS.map((d) => `insertInto${d}`),
];

/** Actions carreau implements (its NavAction): layout operations. */
export const CARREAU_ACTIONS = [
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

const ACTIONS = new Set([...BUCHE_ACTIONS, ...CARREAU_ACTIONS]);

// ── Rules ─────────────────────────────────────────────────────────────────────

/** A mode, as `setMode` enters it. */
export interface ModeSpec {
    name: string;
    /** The modifier held for the mode to last, and on which side. */
    hold: Mod;
    side: Side;
    /** The key entering it (its code): pressed again, see `sticky`. */
    code: string;
    /** "repeat": the key pressed again (still holding) makes the mode last
     *  until it is left; "never": it lasts while held, only. */
    sticky: "repeat" | "never";
}

/** A binding, resolved. */
export interface Rule {
    /** Its chords (more than one: a sequence), in the canonical form. */
    keys: string[];
    action: string;
    args: Record<string, unknown>;
    when: Condition | null;
    /** For setMode: the mode. */
    mode?: ModeSpec;
    /** Where it comes from, for messages. */
    origin: string;
}

const isTable = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);

/** Used when no rule enters a mode. */
const FALLBACK_MODE: ModeSpec = {
    name: "nav",
    hold: "Alt",
    side: "either",
    code: "KeyQ",
    sticky: "repeat",
};

/**
 * Resolve configs' bindings: layers (the defaults, then the user's), their
 * rules one after the other (see the top of this module). What is wrong is
 * reported in `errors` and left out; if no rule is left to enter a mode, one
 * is added (Alt+Q: nav), so that a mistake never leaves the user without a
 * way to navigate. `mac`: whether `Mod` means Cmd (else Ctrl).
 */
export function resolveBindings(
    layers: (BucheConfig | null | undefined)[],
    mac: boolean,
): { rules: Rule[]; errors: string[] } {
    const errors: string[] = [];
    let rules: Rule[] = [];
    layers.forEach((config, layer) => {
        const defaults = layer < layers.length - 1;
        const list = config?.bindings;
        if (list === undefined || list === null) {
            return;
        }
        if (!Array.isArray(list)) {
            errors.push(
                `bindings: expected a list of { key, action, when, args }${defaults ? " (in the defaults)" : ""}`,
            );
            return;
        }
        list.forEach((entry, i) => {
            const origin = `bindings[${i}]${defaults ? " (in the defaults)" : ""}`;
            try {
                const rule = resolveRule(entry, origin, mac);
                if (rule.action.startsWith("-")) {
                    const action = rule.action.slice(1);
                    const key = rule.keys.join(" ");
                    rules = rules.filter(
                        (r) =>
                            !(
                                r.action === action &&
                                (!key || r.keys.join(" ") === key) &&
                                (!rule.when || r.when?.text === rule.when.text)
                            ),
                    );
                } else {
                    rules.push(rule);
                }
            } catch (e) {
                const what =
                    isTable(entry) && typeof entry.key === "string" ? ` (${entry.key})` : "";
                errors.push(`${origin}${what}: ${(e as Error).message}`);
            }
        });
    });

    // The modes entered, and the ones named in conditions.
    const modes = new Map<string, ModeSpec>();
    for (const r of rules) {
        if (r.mode) {
            const other = modes.get(r.mode.name);
            if (other && (other.hold !== r.mode.hold || other.sticky !== r.mode.sticky)) {
                errors.push(
                    `${r.origin}: mode ${r.mode.name} is entered elsewhere with another hold or sticky`,
                );
            }
            modes.set(r.mode.name, r.mode);
        }
    }
    if (modes.size === 0) {
        errors.push("bindings: no rule enters a mode (setMode): using Alt+Q for nav");
        rules.unshift({
            keys: ["Alt+KeyQ"],
            action: "setMode",
            args: { mode: "nav", hold: "alt" },
            when: null,
            mode: FALLBACK_MODE,
            origin: "fallback",
        });
        modes.set("nav", FALLBACK_MODE);
    }
    for (const r of rules) {
        for (const m of r.when?.modes ?? []) {
            if (!modes.has(m)) {
                errors.push(`${r.origin}: no rule enters the mode "${m}" (setMode)`);
            }
        }
    }
    return { rules, errors };
}

/** A rule from a config entry. Throws (a message) if wrong. */
function resolveRule(entry: unknown, origin: string, mac: boolean): Rule {
    if (!isTable(entry)) {
        throw new Error("expected { key, action, when, args }");
    }
    for (const k of Object.keys(entry)) {
        if (!["key", "action", "when", "args"].includes(k)) {
            throw new Error(`unknown field "${k}" (fields: key, action, when, args)`);
        }
    }
    const { key, action, when, args } = entry;
    if (typeof action !== "string" || !action) {
        throw new Error("no action");
    }
    const removal = action.startsWith("-");
    const name = removal ? action.slice(1) : action;
    if (!ACTIONS.has(name)) {
        throw new Error(`unknown action "${name}"`);
    }
    if (args !== undefined && !isTable(args)) {
        throw new Error("args: expected a table");
    }
    if (when !== undefined && typeof when !== "string") {
        throw new Error(`when: expected a condition (quote it if it starts with "!")`);
    }
    if (key !== undefined && typeof key !== "string") {
        throw new Error("key: expected a chord, e.g. ctrl+p (quote it if it has , [ ] or {)");
    }
    if (!removal && !key) {
        throw new Error("no key");
    }
    let condition: Condition | null = null;
    if (when) {
        try {
            condition = parseCondition(when);
        } catch (e) {
            throw new Error(`when: ${(e as Error).message}`);
        }
    }
    const chords = (key ?? "")
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((text) => {
            const chord = parseChord(text, mac);
            if (chord.side !== "either") {
                throw new Error(`${text}: a modifier's side is for setMode's hold, not keys`);
            }
            return chord;
        });
    const rule: Rule = {
        keys: chords.map((c) => chordString(c.mods, c.code)),
        action,
        args: args ?? {},
        when: condition,
        origin,
    };
    if (removal) {
        return rule;
    }
    if (name === "setMode") {
        rule.mode = resolveMode(chords, rule.args, mac);
        return rule;
    }
    // Rules out of any mode take their keys from typing: they need Ctrl, Alt
    // or Cmd (or a function key).
    const [first] = chords;
    const typing = !(["Ctrl", "Alt", "Meta"] as Mod[]).some((m) => first.mods.has(m));
    if (typing && !/^F\d+$/.test(first.code) && !condition?.usesMode) {
        throw new Error("a key without Ctrl, Alt or Cmd needs a mode (when: mode == ...)");
    }
    return rule;
}

/** setMode's mode, from its key and args. Throws (a message) if wrong. */
function resolveMode(chords: Chord[], args: Record<string, unknown>, mac: boolean): ModeSpec {
    const { mode, hold, sticky = "repeat" } = args;
    for (const k of Object.keys(args)) {
        if (!["mode", "hold", "sticky"].includes(k)) {
            throw new Error(`setMode: unknown argument "${k}" (mode, hold, sticky)`);
        }
    }
    if (typeof mode !== "string" || !/^[A-Za-z_][\w-]*$/.test(mode)) {
        throw new Error("setMode: args.mode: expected a name, e.g. nav");
    }
    if (typeof hold !== "string") {
        throw new Error("setMode: args.hold: expected the modifier to hold, e.g. alt");
    }
    if (sticky !== "repeat" && sticky !== "never") {
        throw new Error('setMode: args.sticky: expected "repeat" or "never"');
    }
    let held: Chord;
    try {
        held = parseChord(`${hold}+x`, mac);
    } catch {
        throw new Error(`setMode: args.hold: "${hold}" is not a modifier`);
    }
    if (held.mods.size !== 1) {
        throw new Error("setMode: args.hold: one modifier");
    }
    const [mod] = held.mods;
    if (chords.length !== 1) {
        throw new Error("setMode: one chord, not a sequence");
    }
    const [chord] = chords;
    if (chord.mods.size !== 1 || !chord.mods.has(mod)) {
        throw new Error(`setMode: the key's only modifier must be the one held (${mod})`);
    }
    return { name: mode, hold: mod, side: held.side, code: chord.code, sticky };
}

/**
 * The chords a GUI iframe hands to the page: the first ones of the rules
 * that can apply there (their condition holds in a frame, out of any mode).
 */
export function frameChords(rules: Rule[]): string[] {
    const ctx: Context = { mode: "", inPrompt: false, inPTY: false, inFrame: true };
    const chords = rules.filter((r) => !r.when || r.when.test(ctx)).map((r) => r.keys[0]);
    return [...new Set(chords)];
}
