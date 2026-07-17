/**
 * Register a minimal DOM environment on the global scope, for running Buche
 * outside a browser or the (happy-dom-backed) test runner.
 *
 * Buche's UI components (`src/components/*.tsx`, re-exported through
 * `src/zone.ts`) declare `class X extends HTMLElement` and call
 * `customElements.define(...)` at module-load time. Importing anything that
 * pulls them in — as `scripts/sim.ts` does through `src/core.ts` — therefore
 * throws `ReferenceError: HTMLElement is not defined` when no DOM globals exist
 * (plain `node`/`bun`, as opposed to vitest's `happy-dom` environment).
 *
 * Importing this module installs happy-dom's globals so those classes can be
 * defined. It MUST be imported before any module that references the DOM, so
 * keep it as the very first import of any entrypoint that needs it. Existing
 * globals (e.g. `process`, timers, `fetch`) are left untouched.
 */
import { Window } from "happy-dom";

const window = new Window();

for (const key of Object.getOwnPropertyNames(window)) {
    if (key in globalThis) {
        continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(window, key);
    if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
    }
}
