// Global keyboard chords for the interface: always-live bindings like "Mod+p"
// (Cmd on Mac, Ctrl elsewhere), matched against the full modifier set of the
// event. A chord handler returning `false` did not handle the event: it passes
// through untouched (a conditional chord, e.g. one that only applies to some
// target). (Layout operations, with their navigation mode, are carreau's:
// Alt+Q, see the interface.)
//
// The keydown listener runs in the *capture* phase on window so the chords win
// over descendants (CodeMirror stops propagation of keys it handles) — and
// still see every key, even when the DOM focus sits outside the interface
// altogether (a click in empty space leaves it on `body`).

import { chordFromEvent, expandMod, normalizeChord } from "./keychord.ts";

// A chord handler returning `false` declines the event (it is not swallowed);
// any other return value handles it.
export type KeyHandler = (event: KeyboardEvent) => unknown;

export class GlobalKeys {
    chords = new Map<string, KeyHandler>();

    private detachFn: (() => void) | null = null;

    constructor(chords: Record<string, KeyHandler> = {}) {
        for (const [chord, handler] of Object.entries(chords)) {
            this.on(chord, handler);
        }
    }

    /** Bind an always-live chord (e.g. "Mod+p", "Ctrl+Shift+k"). */
    on(chord: string, handler: KeyHandler): this {
        this.chords.set(normalizeChord(expandMod(chord)), handler);
        return this;
    }

    /** Install the window-level listener; returns the detach function. Keys
     *  are listened for on `window` rather than the interface container: after
     *  a click in empty space (or any blur) the DOM focus sits on `body`, and
     *  events from there never reach a container listener. */
    attach(): () => void {
        this.detach();
        const onKeyDown = (e: Event) => this.handleKeyDown(e as KeyboardEvent);
        // Capture phase: run before descendants (editors) can swallow the key.
        window.addEventListener("keydown", onKeyDown, true);
        this.detachFn = () => window.removeEventListener("keydown", onKeyDown, true);
        return this.detachFn;
    }

    detach(): void {
        this.detachFn?.();
        this.detachFn = null;
    }

    private handleKeyDown(e: KeyboardEvent): void {
        const handler = this.chords.get(chordFromEvent(e));
        if (handler && handler(e) !== false) {
            e.preventDefault();
            e.stopPropagation();
        }
    }
}
