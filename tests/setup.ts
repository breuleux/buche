// Headless DOM for tests.
//
// Loaded once before the test files via `node --import ./tests/setup.ts`.
// It installs a happy-dom `document` (and friends) onto globalThis so the
// production JSX runtime (src/jsx/jsx-runtime.ts) runs unchanged in Node.
//
// Crucially, the DOM constructors (Node, Element, ...) are taken from the
// SAME happy-dom window, so `x instanceof Node` in the runtime matches the
// nodes it creates.

import "tsx";
import { Window } from "happy-dom";

const window = new Window();

const shared = [
    "window",
    "document",
    "Node",
    "Element",
    "HTMLElement",
    "Text",
    "Comment",
    "DocumentFragment",
    "Event",
    "CustomEvent",
    "customElements",
    "getComputedStyle",
] as const;

for (const name of shared) {
    (globalThis as Record<string, unknown>)[name] =
        name === "window" ? window : (window as unknown as Record<string, unknown>)[name];
}
