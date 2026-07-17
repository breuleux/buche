// Global, container-level keyboard bindings for the interface.
//
// Two layers, both installed with plain `keydown`/`keyup` listeners on a
// container element (tinykeys was considered and dropped: it matches static
// chords and timed sequences, but not the "hold Ctrl, tap keys, act on Ctrl
// release" mode needed here — that needs raw keyup tracking anyway):
//
//   - Chords: always-live bindings like "Mod+p" (Cmd on Mac, Ctrl elsewhere),
//     matched against the full modifier set of the event.
//   - Capture mode: `enter` (default Ctrl+Q) starts capturing every non-modifier
//     keydown — swallowing it — until Ctrl is released, which runs the
//     `release` handlers (e.g. commit the focus). Entering runs the `enter`
//     handlers (`onEnter`). Keys are registered with `onCapture`, by name ("p",
//     "ArrowUp", …) or with modifiers other than Ctrl ("Shift+ArrowUp"), Ctrl
//     being held throughout: a key pressed with modifiers first tries the
//     binding with those modifiers, then the bare key's, whatever modifiers
//     ride along.
//
// The keydown listener runs in the *capture* phase so global chords and capture
// mode win over descendants (CodeMirror stops propagation of keys it handles).

import { chordFromEvent, expandMod, normalizeChord } from "./keychord.ts";

export type KeyHandler = (event: KeyboardEvent) => void;

const MODIFIER_KEYS = new Set([
    "Control",
    "ControlLeft",
    "ControlRight",
    "Alt",
    "AltLeft",
    "AltRight",
    "Shift",
    "ShiftLeft",
    "ShiftRight",
    "Meta",
    "MetaLeft",
    "MetaRight",
]);

const CONTROL_KEYS = new Set(["Control", "ControlLeft", "ControlRight"]);

function normalizeKey(key: string): string {
    return key.toLowerCase();
}

// A canonical chord without Ctrl, which is held throughout capture mode.
function captureKey(chord: string): string {
    return chord
        .split("+")
        .filter((part) => part !== "ctrl")
        .join("+");
}

export interface ModalKeysConfig {
    /** Always-live chords, e.g. { "Mod+p": focusPrompt }. */
    chords?: Record<string, KeyHandler>;
    /** The chord that enters capture mode. Default: "Ctrl+q". */
    enter?: string;
    /** Keys captured while in capture mode, e.g. { "ArrowDown": moveDown }. */
    capture?: Record<string, KeyHandler>;
    /** Handlers run when capture mode is entered. */
    onEnter?: KeyHandler | Array<KeyHandler>;
    /** Handlers run when Ctrl is released after entering capture mode. */
    release?: KeyHandler | Array<KeyHandler>;
}

export class ModalKeys {
    /** Capture-mode entry chord, canonical form. */
    enter: string;
    /** Whether capture mode is currently active. */
    capturing = false;

    chords = new Map<string, KeyHandler>();
    capture = new Map<string, KeyHandler>();
    enters: KeyHandler[] = [];
    releases: KeyHandler[] = [];

    private detachFn: (() => void) | null = null;

    constructor(config: ModalKeysConfig = {}) {
        this.enter = normalizeChord(expandMod(config.enter ?? "Ctrl+q"));
        for (const [chord, handler] of Object.entries(config.chords ?? {})) {
            this.on(chord, handler);
        }
        for (const [key, handler] of Object.entries(config.capture ?? {})) {
            this.onCapture(key, handler);
        }
        const release = config.release;
        if (release) {
            this.releases.push(...(Array.isArray(release) ? release : [release]));
        }
        const onEnter = config.onEnter;
        if (onEnter) {
            this.enters.push(...(Array.isArray(onEnter) ? onEnter : [onEnter]));
        }
    }

    /** Bind an always-live chord (e.g. "Mod+p", "Ctrl+Shift+k"). */
    on(chord: string, handler: KeyHandler): this {
        this.chords.set(normalizeChord(expandMod(chord)), handler);
        return this;
    }

    /** Bind a key handled while in capture mode (e.g. "p", "ArrowDown",
     *  "Shift+ArrowDown"; Ctrl, held throughout, is ignored). */
    onCapture(key: string, handler: KeyHandler): this {
        this.capture.set(captureKey(normalizeChord(key)), handler);
        return this;
    }

    /** Add a handler run when capture mode is entered. */
    onEnter(handler: KeyHandler): this {
        this.enters.push(handler);
        return this;
    }

    /** Add a handler run when Ctrl is released after capture mode. */
    onRelease(handler: KeyHandler): this {
        this.releases.push(handler);
        return this;
    }

    /** Install the listeners on `container`; returns the detach function. */
    attach(container: Element): () => void {
        this.detach();
        const onKeyDown = (e: Event) => this.handleKeyDown(e as KeyboardEvent);
        const onKeyUp = (e: Event) => this.handleKeyUp(e as KeyboardEvent);
        // Capture phase: run before descendants (editors) can swallow the key.
        container.addEventListener("keydown", onKeyDown, true);
        // Ctrl may be released with focus anywhere; listen on window.
        window.addEventListener("keyup", onKeyUp);
        this.detachFn = () => {
            container.removeEventListener("keydown", onKeyDown, true);
            window.removeEventListener("keyup", onKeyUp);
        };
        return this.detachFn;
    }

    detach(): void {
        this.detachFn?.();
        this.detachFn = null;
        this.capturing = false;
    }

    private handleKeyDown(e: KeyboardEvent): void {
        if (this.capturing) {
            // Modifier transitions (incl. releasing Ctrl, seen as a keydown
            // autorepeat elsewhere) pass through untouched.
            if (MODIFIER_KEYS.has(e.key)) {
                return;
            }
            e.preventDefault();
            e.stopPropagation();
            const handler =
                this.capture.get(captureKey(chordFromEvent(e))) ??
                this.capture.get(normalizeKey(e.key));
            handler?.(e);
            return;
        }
        const chord = chordFromEvent(e);
        if (chord === this.enter) {
            e.preventDefault();
            e.stopPropagation();
            this.capturing = true;
            for (const handler of this.enters) {
                handler(e);
            }
            return;
        }
        const handler = this.chords.get(chord);
        if (handler) {
            e.preventDefault();
            e.stopPropagation();
            handler(e);
        }
    }

    private handleKeyUp(e: KeyboardEvent): void {
        if (this.capturing && CONTROL_KEYS.has(e.key)) {
            this.capturing = false;
            for (const handler of this.releases) {
                handler(e);
            }
        }
    }
}
