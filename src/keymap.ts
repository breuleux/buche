// The key bindings (see config.ts): rules, matched on every key press of the
// window, and the modes they enter.
//
// On a key press, the last rule for it whose condition holds wins. A rule
// with a sequence of chords (`i enter`) makes its first chord a prefix: the
// next key is looked up after it (holding the prefix key down keeps it for
// every key pressed meanwhile: S held, ← ← → swaps three times; modifiers of
// the prefix's own chord may still be held: Shift+X, then Shift+← is ←).
//
// A mode (setMode) lasts while its modifier is held; its key pressed again
// makes it last until it is left (the key once more, or leaveMode). While it
// is on, its modifier is left out of the chords (Alt+Left is Left), and keys
// typed in a text field (a tab's title being edited) are the field's. The
// layout is in carreau's navigation mode meanwhile (`setNavMode`).
//
// The listeners run in the *capture* phase on window, so the bindings win
// over descendants (CodeMirror stops propagation of keys it handles) — and
// still see every key, even when the DOM focus sits outside the interface
// altogether (a click in empty space leaves it on `body`).

import type { NavMode } from "carreau";
import { CARREAU_MOD, type Context, eventChords, type ModeSpec, type Rule } from "./config.ts";

const MODIFIER_CODE = /^(Alt|Control|Meta|Shift)(Left|Right)$/;

export interface KeymapHost {
    /** Run a rule's action (not setMode / leaveMode: the keymap's). */
    run(rule: Rule, event: KeyboardEvent): void;
    /** The context of a key event, but the mode. */
    context(event: KeyboardEvent): Omit<Context, "mode">;
    /** Carreau's navigation mode, following the modes. */
    setNavMode(mode: NavMode, commit: boolean): void;
    /** A key no rule took (out of any mode): true if the host did (it is
     *  then swallowed). */
    unmatched?(event: KeyboardEvent): boolean;
}

const isTextField = (t: EventTarget | null): boolean =>
    t instanceof HTMLElement &&
    (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));

export class Keymap {
    /** The mode on, if any, and whether it's sticky. */
    active: { spec: ModeSpec; sticky: boolean } | null = null;
    /** A pending sequence: its chords so far, and its last key's state. */
    private pending: {
        chords: string[];
        code: string;
        held: boolean;
        used: boolean;
    } | null = null;
    /** Physical modifier keys held (`KeyboardEvent.code`, e.g. "AltLeft"). */
    private heldMods = new Set<string>();
    private detachFn: (() => void) | null = null;

    constructor(
        readonly rules: Rule[],
        private host: KeymapHost,
    ) {}

    /** The mode on ("" if none). */
    get mode(): string {
        return this.active?.spec.name ?? "";
    }

    attach(target: Window = window): () => void {
        this.detach();
        const keydown = (e: Event) => this.keydown(e as KeyboardEvent);
        const keyup = (e: Event) => this.keyup(e as KeyboardEvent);
        const blur = () => this.blur();
        target.addEventListener("keydown", keydown, true);
        target.addEventListener("keyup", keyup, true);
        target.addEventListener("blur", blur);
        this.detachFn = () => {
            target.removeEventListener("keydown", keydown, true);
            target.removeEventListener("keyup", keyup, true);
            target.removeEventListener("blur", blur);
        };
        return this.detachFn;
    }

    detach(): void {
        this.detachFn?.();
        this.detachFn = null;
    }

    /** Enter a mode (held: until its modifier is released). */
    enter(spec: ModeSpec, sticky = false): void {
        this.pending = null;
        this.active = { spec, sticky };
        this.host.setNavMode(sticky ? "sticky" : "held", true);
    }

    /** Leave the mode, if any. `commit`: the selected cell takes the focus. */
    leave(commit = true): void {
        this.pending = null;
        if (!this.active) {
            return;
        }
        this.active = null;
        this.host.setNavMode("off", commit);
    }

    private modifierHeld(spec: ModeSpec, e: KeyboardEvent): boolean {
        const mod = CARREAU_MOD[spec.hold];
        const flag = { Shift: e.shiftKey, Alt: e.altKey, Ctrl: e.ctrlKey, Meta: e.metaKey }[
            spec.hold
        ];
        if (!flag) {
            return false;
        }
        return (
            spec.side === "either" ||
            this.heldMods.has(mod + (spec.side === "left" ? "Left" : "Right"))
        );
    }

    /** The rule for these chords (the last one whose condition holds). */
    private find(
        chords: string[],
        ctx: Context,
        test: (rule: Rule, chord: string) => boolean,
    ): Rule | null {
        for (const chord of chords) {
            for (let i = this.rules.length - 1; i >= 0; i--) {
                const rule = this.rules[i];
                if (test(rule, chord) && (!rule.when || rule.when.test(ctx))) {
                    return rule;
                }
            }
        }
        return null;
    }

    private swallow(e: KeyboardEvent): void {
        e.preventDefault();
        e.stopPropagation();
    }

    private keydown(e: KeyboardEvent): void {
        if (MODIFIER_CODE.test(e.code)) {
            this.heldMods.add(e.code);
            return;
        }
        const active = this.active;
        if (active) {
            // A field in the workspace (a title being edited): its keys.
            if (isTextField(e.target)) {
                return;
            }
            // The mode's key again: it becomes sticky (still holding), or ends.
            if (e.code === active.spec.code) {
                this.swallow(e);
                if (e.repeat) {
                    return;
                }
                if (!active.sticky && active.spec.sticky === "repeat") {
                    this.enter(active.spec, true);
                } else if (active.sticky) {
                    this.leave();
                }
                return;
            }
        }
        const chords = eventChords(e, active?.spec.hold);
        const ctx: Context = { ...this.host.context(e), mode: this.mode };

        if (this.pending) {
            const pending = this.pending;
            // Modifiers of the prefix's chord may still be held: ignore them.
            const prefixMods = pending.chords.at(-1)?.split("+").slice(0, -1) ?? [];
            const bare = chords.map((c) =>
                c
                    .split("+")
                    .filter((p, i, all) => i === all.length - 1 || !prefixMods.includes(p))
                    .join("+"),
            );
            const n = pending.chords.length;
            const prefixed = (rule: Rule, chord: string) =>
                rule.keys.length === n + 1 &&
                pending.chords.every((c, i) => rule.keys[i] === c) &&
                rule.keys[n] === chord;
            const rule = this.find([...chords, ...bare], ctx, prefixed);
            this.swallow(e);
            if (rule) {
                pending.used = true;
                if (!pending.held) {
                    this.pending = null;
                }
                this.run(rule, e);
            } else {
                // Any other key cancels the sequence.
                this.pending = null;
            }
            return;
        }

        // The first chord of a sequence: wait for the next one.
        const prefix = this.find(
            chords,
            ctx,
            (rule, chord) => rule.keys.length > 1 && rule.keys[0] === chord,
        );
        if (prefix) {
            this.swallow(e);
            this.pending = { chords: [prefix.keys[0]], code: e.code, held: true, used: false };
            return;
        }
        const rule = this.find(
            chords,
            ctx,
            (r, chord) =>
                r.keys.length === 1 &&
                r.keys[0] === chord &&
                // (A mode's modifier may be restricted to one side.)
                (!r.mode || this.modifierHeld(r.mode, e)),
        );
        if (!rule) {
            if (!active && this.host.unmatched?.(e)) {
                this.swallow(e);
            }
            return;
        }
        this.swallow(e);
        this.run(rule, e);
    }

    private run(rule: Rule, e: KeyboardEvent): void {
        if (rule.action === "setMode" && rule.mode) {
            if (!e.repeat) {
                this.enter(rule.mode);
            }
            return;
        }
        if (rule.action === "leaveMode") {
            this.leave();
            return;
        }
        this.host.run(rule, e);
    }

    private keyup(e: KeyboardEvent): void {
        this.heldMods.delete(e.code);
        // Releasing the prefix key: if it was used while held, it's done;
        // otherwise it stays pending for the next key (one-shot).
        if (this.pending && e.code === this.pending.code) {
            this.pending.held = false;
            if (this.pending.used) {
                this.pending = null;
            }
        }
        const active = this.active;
        if (active && !active.sticky && e.key === CARREAU_MOD[active.spec.hold]) {
            const { side } = active.spec;
            if (
                side === "either" ||
                e.code === CARREAU_MOD[active.spec.hold] + (side === "left" ? "Left" : "Right")
            ) {
                // On Windows/Linux, releasing a bare Alt focuses the menu bar: not here.
                e.preventDefault();
                this.leave();
            }
        }
    }

    private blur(): void {
        // A modifier released while the window had no focus never sends keyup.
        this.heldMods.clear();
        // (The focus went elsewhere: don't let the cell take it back.)
        if (this.active && !this.active.sticky) {
            this.leave(false);
        }
    }
}
