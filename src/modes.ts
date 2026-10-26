// Several modes (see config.ts: `modifiers`), each one a carreau navigation
// mode (KeyboardNav) of its own, sharing the window's keys: one at a time.
//
// A KeyboardNav listens on the target it is given: here, each gets a stand-in
// target, and a single set of window listeners hands it the events it is to
// see. While a mode is on, the keys are its alone (its bindings may be the
// chords of other modes: Alt+Q, then W). While none is, each one in turn is
// offered the key, until one of them is entered by it. Modifier keys, key
// releases and the window's blur reach all of them: each tracks which
// modifier keys are held.

import type { KeyboardNav } from "carreau";

const MODIFIER_CODE = /^(Alt|Control|Meta|Shift)(Left|Right)$/;

type Listener = (e: Event) => void;

/** What a KeyboardNav listens on (a Window, as far as it is concerned). */
export class ModeTarget {
    private listeners = new Map<string, Listener[]>();

    addEventListener(type: string, fn: Listener): void {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
    }

    removeEventListener(type: string, fn: Listener): void {
        this.listeners.set(
            type,
            (this.listeners.get(type) ?? []).filter((f) => f !== fn),
        );
    }

    /** Hand an event to the listeners. */
    deliver(e: Event): void {
        for (const fn of this.listeners.get(e.type) ?? []) {
            fn(e);
        }
    }

    /** As the window, for KeyboardNav's constructor. */
    asWindow(): Window {
        return this as unknown as Window;
    }
}

export class ModeRouter {
    private modes: { nav: KeyboardNav; target: ModeTarget }[] = [];

    constructor(target: Window = window) {
        target.addEventListener("keydown", (e) => this.keydown(e), { capture: true });
        target.addEventListener("keyup", (e) => this.all(e), { capture: true });
        target.addEventListener("blur", (e) => this.all(e));
    }

    /** Route events to this mode, made with `target` (see ModeTarget). */
    add(nav: KeyboardNav, target: ModeTarget): void {
        this.modes.push({ nav, target });
    }

    /** The mode that is on, if any. */
    active(): KeyboardNav | null {
        return this.modes.find(({ nav }) => nav.mode !== "off")?.nav ?? null;
    }

    private all(e: Event): void {
        for (const { target } of this.modes) {
            target.deliver(e);
        }
    }

    private keydown(e: KeyboardEvent): void {
        if (MODIFIER_CODE.test(e.code)) {
            this.all(e);
            return;
        }
        const on = this.modes.find(({ nav }) => nav.mode !== "off");
        if (on) {
            on.target.deliver(e);
            return;
        }
        for (const { nav, target } of this.modes) {
            target.deliver(e);
            if (nav.mode !== "off" || e.defaultPrevented) {
                return;
            }
        }
    }
}
