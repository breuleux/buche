// A GUI cell hosting arbitrary HTML in an iframe: `<buche-gui>`.
//
//   const gui = document.createElement("buche-gui") as BucheGui;
//   gui.html = "<input autofocus> <button>ok</button>";
//   container.appendChild(gui);
//
// The element itself is what takes part in focus navigation (it is tagged
// `focusable="gui"` and takes the DOM focus itself), so navigating onto it
// never moves the focus into the iframe, and the page keeps receiving keys.
// The focus only goes inside on `commitFocus()`, which the FocusManager calls
// on the current element when a navigation is committed (see focus.ts).
//
// The element injects a small runtime into the iframe's document, which:
//
//   * intercepts the chords given by `interceptChords` before the iframe's
//     own content sees them, and hands them to the page:
//     <buche-gui> takes the DOM focus back and re-dispatches the chord as a
//     bubbling "keydown" on itself, so the page's bindings see it as if it had
//     been typed there. Key-ups that happen before the focus has left the
//     iframe (e.g. releasing Control right away) are forwarded the same way.
//   * on `commitFocus()`, restores the focus to the element that last had it
//     inside the iframe, or else to its `[autofocus]` element.
//
// Nothing is intercepted by default. `interceptChords` is read, and the chords
// sent to the iframe, each time the focus enters it (on `commitFocus()`, or on
// a click inside it), so the set can change at any time; e.g. with a global
// binding for nav mode: `gui.interceptChords = () => [bindings.navMode]`.
//
// Communication goes through postMessage only, so it works with sandboxed
// (cross-origin) iframes too; messages are only accepted from the iframe's
// own window.
//
// Appearance lives in the companion stylesheet `buche-gui.css` (or the
// consolidated components.css).

import type { DomProps } from "myjsx/jsx-runtime";
import type { FocusCommittable } from "../focus.ts";
import { normalizeChord } from "../keychord.ts";

// Marks our messages (and says which kind they are), both ways.
const TAG = "buche-gui";

/** A key event forwarded from the iframe. */
interface KeyMessage {
    [TAG]: "keydown" | "keyup";
    key: string;
    code: string;
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
    metaKey: boolean;
}

// The runtime, run inside the iframe. It is stringified into the iframe's
// document, so it must be self-contained: no imports, no outer variables.
function bucheGuiRuntime(): void {
    const TAG = "buche-gui";
    // Set by the page each time the focus enters the iframe.
    let chords = new Set<string>();
    // Whether a chord was handed to the page and the focus hasn't left yet.
    let handingOff = false;
    let last: HTMLElement | null = null;

    // Same format as chordFromEvent in keychord.ts.
    const chordOf = (e: KeyboardEvent): string => {
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
        parts.push(e.key === " " ? "space" : e.key.toLowerCase());
        return parts.join("+");
    };

    const forward = (type: "keydown" | "keyup", e: KeyboardEvent): void => {
        window.parent.postMessage(
            {
                [TAG]: type,
                key: e.key,
                code: e.code,
                ctrlKey: e.ctrlKey,
                altKey: e.altKey,
                shiftKey: e.shiftKey,
                metaKey: e.metaKey,
            },
            "*",
        );
    };

    window.addEventListener("message", (e) => {
        if (e.source !== window.parent) {
            return;
        }
        const data = e.data;
        if (data?.[TAG] === "config") {
            chords = new Set(data.chords);
        } else if (data?.[TAG] === "focus") {
            const target = last?.isConnected
                ? last
                : document.querySelector<HTMLElement>("[autofocus]");
            target?.focus();
        }
    });

    window.addEventListener(
        "keydown",
        (e) => {
            if (chords.has(chordOf(e))) {
                e.preventDefault();
                e.stopImmediatePropagation();
                handingOff = true;
                forward("keydown", e);
            }
        },
        true,
    );

    window.addEventListener(
        "keyup",
        (e) => {
            if (handingOff) {
                e.preventDefault();
                e.stopImmediatePropagation();
                forward("keyup", e);
            }
        },
        true,
    );

    window.addEventListener("blur", () => {
        handingOff = false;
    });

    document.addEventListener("focusin", (e) => {
        if (e.target instanceof HTMLElement) {
            last = e.target;
        }
    });
}

const RUNTIME = `<script>(${bucheGuiRuntime.toString()})();</script>`;

// Put the runtime first in the document (after the doctype, if any, so the
// document doesn't drop to quirks mode).
function inject(html: string): string {
    const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
    return doctype ? doctype[0] + RUNTIME + html.slice(doctype[0].length) : RUNTIME + html;
}

export class BucheGui extends HTMLElement implements FocusCommittable {
    /**
     * Chords the iframe hands to the page instead of handling them (e.g.
     * "Ctrl+Q"). Called each time the focus enters the iframe.
     */
    interceptChords: () => readonly string[] = () => [];

    private initialized = false;
    private frame!: HTMLIFrameElement;
    private content = "";

    connectedCallback(): void {
        this.ensureSetup();
        window.addEventListener("message", this.onMessage);
        window.addEventListener("blur", this.onWindowBlur);
    }

    disconnectedCallback(): void {
        window.removeEventListener("message", this.onMessage);
        window.removeEventListener("blur", this.onWindowBlur);
    }

    private ensureSetup(): void {
        if (this.initialized) {
            return;
        }
        this.initialized = true;
        if (!this.hasAttribute("focusable")) {
            this.setAttribute("focusable", "gui");
        }
        if (!this.hasAttribute("tabindex")) {
            this.tabIndex = -1;
        }
        this.frame = document.createElement("iframe");
        const sandbox = this.getAttribute("sandbox");
        if (sandbox !== null) {
            this.frame.setAttribute("sandbox", sandbox);
        }
        this.appendChild(this.frame);
        this.render();
    }

    /** The iframe element. */
    get iframe(): HTMLIFrameElement {
        this.ensureSetup();
        return this.frame;
    }

    /** The HTML shown in the iframe (the runtime is added to it). */
    get html(): string {
        return this.content;
    }

    set html(value: string) {
        this.content = value;
        this.render();
    }

    /** Send the focus inside the iframe. */
    commitFocus(): void {
        this.ensureSetup();
        this.sendConfig();
        this.frame.focus();
        this.post({ [TAG]: "focus" });
    }

    private render(): void {
        if (this.initialized) {
            this.frame.srcdoc = inject(this.content);
        }
    }

    private sendConfig(): void {
        this.post({ [TAG]: "config", chords: this.interceptChords().map(normalizeChord) });
    }

    private post(message: unknown): void {
        this.frame.contentWindow?.postMessage(message, "*");
    }

    // A click inside the iframe gives it the focus without the page seeing the
    // click; the page's window blurs with the iframe as the active element.
    // (After commitFocus(), the config was already sent; sending it again is
    // harmless.)
    private onWindowBlur = (): void => {
        if (document.activeElement === this.frame) {
            this.sendConfig();
        }
    };

    private onMessage = (e: MessageEvent): void => {
        if (e.source !== this.frame.contentWindow) {
            return;
        }
        const data = e.data as KeyMessage;
        const type = data?.[TAG];
        if (type !== "keydown" && type !== "keyup") {
            return;
        }
        // Take the DOM focus back first, so what follows (e.g. navigation
        // keys, the Control release) is typed into the page, not the iframe.
        if (type === "keydown") {
            this.focus();
        }
        const { key, code, ctrlKey, altKey, shiftKey, metaKey } = data;
        this.dispatchEvent(
            new KeyboardEvent(type, {
                key,
                code,
                ctrlKey,
                altKey,
                shiftKey,
                metaKey,
                bubbles: true,
                cancelable: true,
                composed: true,
            }),
        );
    };
}

if (typeof customElements !== "undefined") {
    if (!customElements.get("buche-gui")) {
        customElements.define("buche-gui", BucheGui);
    }
}

declare module "myjsx/jsx-runtime" {
    namespace JSX {
        interface CustomElements {
            "buche-gui": DomProps<BucheGui>;
        }
    }
}
