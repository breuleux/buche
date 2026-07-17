// Shared key-chord parsing, used by prompt bindings (prompt-collection.tsx)
// and by the interface's global bindings (keybindings.ts).

/** Modifier aliases → canonical modifier name. */
const MODIFIER_ALIASES: Record<string, "ctrl" | "alt" | "shift" | "meta"> = {
    ctrl: "ctrl",
    control: "ctrl",
    alt: "alt",
    option: "alt",
    opt: "alt",
    shift: "shift",
    meta: "meta",
    cmd: "meta",
    command: "meta",
    super: "meta",
    win: "meta",
    windows: "meta",
};

const MODIFIER_ORDER = ["ctrl", "alt", "shift", "meta"] as const;

/** Whether this looks like a Mac, where `Mod` means Cmd (else Ctrl). */
export function isMac(): boolean {
    const nav = typeof navigator !== "undefined" ? navigator : undefined;
    const source = `${nav?.userAgent ?? ""} ${nav?.platform ?? ""}`;
    return /mac|iphone|ipad|ipod/i.test(source);
}

/** Expand the `Mod` pseudo-modifier to `cmd` on Mac, `ctrl` elsewhere. */
export function expandMod(chord: string): string {
    return chord
        .split("+")
        .map((token) =>
            token.trim().toLowerCase() === "mod" ? (isMac() ? "cmd" : "ctrl") : token,
        )
        .join("+");
}

/** Normalize a single key name (case-insensitive; space → "space"). */
function normalizeKeyName(key: string): string {
    const k = key.trim();
    return k === " " ? "space" : k.toLowerCase();
}

/** A canonical chord for a keyboard event, e.g. "ctrl+shift+l". */
export function chordFromEvent(e: KeyboardEvent): string {
    const parts: string[] = [];
    if (e.ctrlKey) {
        parts.push("ctrl");
    }
    if (e.altKey) {
        parts.push("alt");
    }
    if (e.shiftKey) {
        parts.push("shift");
    }
    if (e.metaKey) {
        parts.push("meta");
    }
    parts.push(normalizeKeyName(e.key));
    return parts.join("+");
}

/** Normalize a binding string like "Ctrl+L" into a canonical chord "ctrl+l". */
export function normalizeChord(chord: string): string {
    const mods = new Set<string>();
    let key = "";
    for (const raw of chord.split("+")) {
        const token = raw.trim().toLowerCase();
        if (!token) {
            continue;
        }
        const mod = MODIFIER_ALIASES[token];
        if (mod) {
            mods.add(mod);
        } else {
            key = normalizeKeyName(raw);
        }
    }
    return [...MODIFIER_ORDER.filter((m) => mods.has(m)), key].filter(Boolean).join("+");
}
