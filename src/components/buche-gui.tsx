// A GUI cell hosting arbitrary HTML in an iframe: `<buche-gui>`.
//
//   const gui = document.createElement("buche-gui") as BucheGui;
//   gui.html = "<input autofocus> <button>ok</button>";
//   container.appendChild(gui);
//   gui.send({ type: "html", mode: "append", content: "<p>hi</p>" });
//
// The element itself is what takes part in focus navigation (it is tagged
// `focusable="gui"` and takes the DOM focus itself), so navigating onto it
// never moves the focus into the iframe, and the page keeps receiving keys.
// The focus only goes inside on `commitFocus()`, which the FocusManager calls
// on the current element when a navigation is committed (see focus.ts).
//
// The element injects a runtime into the iframe's document, which:
//
//   * executes *commands* posted to it (see {@link BucheGui.send}):
//       html               inject HTML (append/set/replace, optional selector);
//                          scripts are re-created so they execute
//       exec               evaluate JavaScript (as an expression when
//                          `response_id` is set — the result is relayed back)
//       data               dispatch on `data.$schema` (built-in: "buche:plain",
//                          "buche:text"; more via register_schemas)
//       register           add command handlers (function source strings)
//       register_schemas   add `data` handlers (function source strings)
//       resolve            answer a pending `proc://` resource request
//       cache              pre-seed the `proc://` cache
//       response           resolve a pending `buche.request()`
//   * intercepts the chords given by `interceptChords` before the iframe's
//     own content sees them, and hands them to the page:
//     <buche-gui> takes the DOM focus back and re-dispatches the chord as a
//     bubbling "keydown" on itself, so the page's bindings see it as if it had
//     been typed there. Key-ups that happen before the focus has left the
//     iframe (e.g. releasing Control right away) are forwarded the same way.
//   * on `commitFocus()`, restores the focus to the element that last had it
//     inside the iframe, or else to its `[autofocus]` / `#prime-focus` element.
//   * reports its content height; the element sizes itself to it — unless the
//     cell has a height of its own (pinned by a gutter drag, or filling a
//     tab-pane pane), when the element instead fills the cell and the reports
//     are ignored.
//   * receives the cell's sizing information (sent before the queued commands
//     on ready, and again whenever the cell resizes, e.g. from a gutter drag):
//     it is stored as `window.bucheInfo` ({width, height, maxHeight,
//     dynamicHeight}, the contract page programs like `bed` rely on) and
//     re-broadcast inside the page as a bubbling "buche-info" event, so
//     scripts can react to updates. When the cell is filled rather than
//     content-sized (`dynamicHeight` false) a `html, body { height: 100% }`
//     style is also installed, so percentage layouts work in that mode.
//
// Inside the iframe, scripts get a `buche` API:
//
//   buche(data)            relay `data` to the page (a "gui-send" event)
//   buche.request(data)    same, but returns a Promise resolved by a `response`
//                          command carrying the same `response_id`
//   buche.proc(url)        fetch a `proc://` resource (see below), as a Response
//   buche.blur()           hand the focus back to the page (it stays on the
//                          cell)
//   buche.leave()          "the user is done": the focus leaves the cell
//                          entirely, even if the cell is sticky (the cell
//                          itself is untouched)
//
// # `proc://` resources
//
// Resources are addressed per element, as `proc://<proc-cell-id>/<path>`. The
// request (with its `request_id`) is relayed to the page as a `gui-send` event
// (data `{type: "resolve", request_id, path, params, method}`); whoever answers
// calls {@link BucheGui.respond}.
//
//   * Over the web the iframe is an opaque-origin `srcdoc` document, so the
//     runtime *shims* the scheme: `fetch` and `XMLHttpRequest` are patched, and
//     `proc:` URLs in `src`/`href` attributes are rewritten to blob: URLs.
//   * In Electron the scheme is registered for real (see `electron/`), the
//     iframe loads from `proc://<id>/`, and the runtime steps aside: native
//     fetch/attributes work, and responses go through the preload bridge
//     (`window.buche.proc.respond`) instead of postMessage.
//     The runtime picks the native path when the document's own origin is a
//     `proc:` one, or when a preload bridge is present.
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
import { expandMod, normalizeChord } from "../keychord.ts";
import type { Json } from "../types.ts";
import { RUNTIME } from "./buche-gui-runtime.ts";
import type { EchoBox } from "./echo-box.tsx";

// Marks our messages (and says which kind they are), both ways.
const TAG = "buche-gui";

/** Event bubbled by `<buche-gui>` when the iframe relays a message out
 *  (`buche(data)`, `buche.request(data)`, `proc://` requests, exec results).
 *  The `detail` is the payload; the entry it belongs to is found through the
 *  enclosing `<echo-box>`. */
export const GUI_SEND_EVENT = "gui-send";

/** Event bubbled by `<buche-gui>` when the element is first created (the GUI
 *  view of a cell has just come into existence); the interface uses it to move
 *  the focus to the new GUI. */
export const GUI_APPEAR_EVENT = "gui-appear";

/** An answer to a pending `proc://` request (see {@link BucheGui.respond}). */
export interface ProcResponse {
    status?: number;
    content?: string;
    mimetype?: string;
    encoding?: string;
}

// Put the runtime first in the document (after the doctype, if any, so the
// document doesn't drop to quirks mode).
function inject(html: string): string {
    const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
    return doctype ? doctype[0] + RUNTIME + html.slice(doctype[0].length) : RUNTIME + html;
}

/** The preload bridge the Electron glue exposes (see `electron/preload.ts`). */
interface ProcBridge {
    respond: (
        requestId: string,
        status: number,
        content: string,
        mimetype: string,
        encoding?: string | null,
    ) => void;
    cache: (
        cellId: string,
        path: string,
        content: string,
        mimetype: string,
        encoding?: string | null,
    ) => void;
}

function procBridge(): ProcBridge | null {
    const w = window as any;
    const bridge = w.buche?.proc;
    return bridge && typeof bridge.respond === "function" ? (bridge as ProcBridge) : null;
}

export class BucheGui extends HTMLElement implements FocusCommittable {
    /**
     * Chords every new <buche-gui> hands to the page instead of letting the
     * iframe content see them. The interface sets this once (to the
     * capture-mode chord, so nav mode escapes any GUI); per-element overrides
     * go through {@link interceptChords}.
     */
    static defaultInterceptChords: () => readonly string[] = () => [];

    /**
     * Chords the iframe hands to the page instead of handling them (e.g.
     * "Ctrl+Q"). Called each time the focus enters the iframe. Defaults to
     * {@link BucheGui.defaultInterceptChords}.
     */
    interceptChords: () => readonly string[] = () => BucheGui.defaultInterceptChords();

    private initialized = false;
    private frame!: HTMLIFrameElement;
    private content = "";
    private ready = false;
    private queue: unknown[] = [];
    // The enclosing cell box, once found; its "resize" event (the box polls
    // its size each frame) drives the size-info updates sent to the page.
    private box: EchoBox | null = null;

    connectedCallback(): void {
        this.ensureSetup();
        this.ensureBox();
        window.addEventListener("message", this.onMessage);
        window.addEventListener("blur", this.onWindowBlur);
    }

    disconnectedCallback(): void {
        window.removeEventListener("message", this.onMessage);
        window.removeEventListener("blur", this.onWindowBlur);
        if (this.box !== null) {
            this.box.removeEventListener("resize", this.onBoxResize);
            this.box = null;
        }
    }

    // Moved along with its box (moveBefore), it stays as it is.
    connectedMoveCallback(): void {}

    private ensureBox(): void {
        if (this.box !== null) {
            return;
        }
        const box = this.closest("echo-box") as EchoBox | null;
        if (box === null) {
            return;
        }
        this.box = box;
        box.addEventListener("resize", this.onBoxResize);
    }

    private onBoxResize = (): void => {
        this.sendInfo();
    };

    /** Whether the GUI sizes itself to its content (the iframe reports a
     *  height, and the element grows to it). False when the cell has a height
     *  of its own — pinned by a gutter drag (the `pinned` attribute), or a box
     *  filling its pane (`fills`) — in which case the GUI just fills it (CSS, see
     *  the echo-box stylesheet; compare the fitting logic in cell.ts). */
    private dynamicSizing(): boolean {
        this.ensureBox();
        const box = this.box;
        const pinned = (box?.cellContentHeight ?? null) !== null;
        const fillsPane = box?.hasAttribute("fills") ?? false;
        return !pinned && !fillsPane;
    }

    /** The sizing mode the element was last set up for (see
     *  {@link applySizingMode}); null until the first sizing info. */
    private sizedTo: "content" | "fill" | null = null;

    /** The height last reported by the page (content sizing). Kept across a
     *  fill stint so coming back does not collapse the element to the
     *  stylesheet default while it waits for a report that may never come
     *  (a page whose layout did not change has nothing new to report). */
    private lastReported = 0;

    /** Switch between the two sizing modes: content sizing drives the
     *  element's height from the iframe's reports (inline style), fill sizing
     *  leaves it to the stylesheet's 100% so the fixed cell wins. The modes
     *  must not fight, so taking over clears the other's inline height —
     *  content sizing restoring the last reported height instead of nothing. */
    private applySizingMode(dynamic: boolean): void {
        const mode = dynamic ? "content" : "fill";
        if (mode === this.sizedTo) {
            return;
        }
        this.sizedTo = mode;
        if (dynamic) {
            this.style.height = this.lastReported > 0 ? `${this.lastReported}px` : "";
        } else {
            this.style.removeProperty("height");
        }
    }

    /** Tell the page the cell's sizing information (stored there as
     *  `window.bucheInfo`, see the runtime): the rendered size of the cell,
     *  the height its dynamic sizing can grow to before the box clamps it
     *  (0 = no ceiling), and whether the GUI sizes itself to its content at
     *  all (a box pinned by a drag, or filling a pane, does not). Also brings
     *  the element's own sizing in line with the mode. */
    private sendInfo(): void {
        const dynamic = this.dynamicSizing();
        this.applySizingMode(dynamic);
        const box = this.box;
        const cell =
            box !== null ? box.cellSize : { height: this.clientHeight, width: this.clientWidth };
        const message = {
            [TAG]: "info",
            width: cell.width,
            height: cell.height,
            maxHeight: box?.maxContentHeight ?? 0,
            dynamicHeight: dynamic,
        };
        if (!this.ready) {
            // Only the freshest value matters: drop any queued earlier info
            // and keep the message ahead of the commands it must precede.
            this.queue = this.queue.filter(
                (m) => (m as Record<string, unknown>)?.[TAG] !== "info",
            );
            this.queue.unshift(message);
            return;
        }
        this.frame.contentWindow?.postMessage(message, "*");
    }

    /** The per-cell id `proc://` URLs are served under (the `proc-cell-id`
     *  attribute). */
    get procCellId(): string {
        return this.getAttribute("proc-cell-id") ?? "";
    }

    /** Whether the iframe document is served from the natively registered
     *  `proc://` scheme (Electron) rather than injected as `srcdoc` (web). */
    get native(): boolean {
        return this.getAttribute("protocol") === "proc";
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
        // Opt into native mode when the Electron preload bridge is present
        // (unless the protocol was pinned to srcdoc).
        if (!this.hasAttribute("protocol") && procBridge() !== null && this.procCellId !== "") {
            this.setAttribute("protocol", "proc");
        }
        this.frame = document.createElement("iframe");
        const sandbox = this.getAttribute("sandbox");
        if (sandbox !== null) {
            this.frame.setAttribute("sandbox", sandbox);
        }
        this.appendChild(this.frame);
        if (this.native && this.procCellId !== "") {
            // The runtime document comes from the scheme handler.
            this.frame.src = `proc://${this.procCellId}/`;
        } else {
            this.render();
        }
    }

    /** The iframe element. */
    get iframe(): HTMLIFrameElement {
        this.ensureSetup();
        return this.frame;
    }

    /** The HTML shown in the iframe. In srcdoc mode the document is rebuilt
     *  from it (the runtime is added); in native mode it becomes a `set`-mode
     *  `html` command into the runtime document. */
    get html(): string {
        return this.content;
    }

    set html(value: string) {
        this.content = value;
        this.ensureSetup();
        if (this.native) {
            this.post({ type: "html", mode: "set", content: value });
        } else {
            this.render();
        }
    }

    /** Send a command to the runtime (queued until the iframe is ready). */
    send(command: { type: string }): void {
        this.ensureSetup();
        this.post(command);
    }

    /** Answer a pending `proc://` request relayed by the iframe. */
    respond(requestId: string, response: ProcResponse): void {
        const bridge = this.native ? procBridge() : null;
        if (bridge) {
            bridge.respond(
                requestId,
                response.status ?? 200,
                response.content ?? "",
                response.mimetype ?? "application/octet-stream",
                response.encoding ?? null,
            );
            return;
        }
        this.post({
            type: "resolve",
            request_id: requestId,
            status: response.status ?? 200,
            content: response.content ?? "",
            mimetype: response.mimetype ?? "application/octet-stream",
            encoding: response.encoding ?? null,
        });
    }

    /** Pre-push a `proc://` resource into the runtime's cache. */
    cache(path: string, content: string, mimetype?: string, encoding?: string): void {
        const bridge = this.native ? procBridge() : null;
        if (bridge) {
            bridge.cache(
                this.procCellId,
                path,
                content,
                mimetype ?? "application/octet-stream",
                encoding ?? null,
            );
            return;
        }
        this.post({ type: "cache", path, content, mimetype, encoding });
    }

    /** Send the focus inside the iframe. */
    commitFocus(): void {
        this.ensureSetup();
        this.sendConfig();
        this.frame.focus();
        this.postTagged({ [TAG]: "focus" });
    }

    private render(): void {
        if (this.initialized && !this.native) {
            this.ready = false;
            this.queue = [];
            this.frame.srcdoc = inject(this.content);
        }
    }

    private sendConfig(): void {
        const chords = this.interceptChords().map((c) => normalizeChord(expandMod(c)));
        this.postTagged({ [TAG]: "config", chords });
    }

    private post(message: unknown): void {
        if (this.ready) {
            this.frame.contentWindow?.postMessage(message, "*");
        } else {
            this.queue.push(message);
        }
    }

    private postTagged(message: Record<string, unknown>): void {
        // Focus/config messages reach the runtime directly, no need to queue.
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
        const data = e.data as any;
        const type = data?.[TAG];
        if (type === "ready") {
            this.ready = true;
            // First the sizing information, so scripts run by the queued
            // commands (the old `bucheInfo` ordering) can already see it.
            this.sendInfo();
            for (const message of this.queue.splice(0)) {
                this.frame.contentWindow?.postMessage(message, "*");
            }
            // The chords to hand back, and the focus, may have been sent
            // before the document was up (the GUI takes the focus as soon as
            // it appears): they were lost then.
            this.sendConfig();
            if (document.activeElement === this.frame) {
                this.postTagged({ [TAG]: "focus" });
            }
            return;
        }
        if (type === "resize") {
            // While filling a fixed cell the element's height is the cell's,
            // not the content's: the report is moot (the iframe's window sees
            // a "resize" event whenever the cell changes, which is what the
            // page should react to).
            if (!this.dynamicSizing()) {
                return;
            }
            const px = `${Math.max(0, Math.ceil(data.height as number))}px`;
            this.lastReported = Number.parseInt(px, 10);
            if (this.style.height !== px) {
                this.style.height = px;
                // Let containers that size other views against this one refit
                // (the terminal matching the GUI's height, see cell.ts).
                this.dispatchEvent(new CustomEvent("gui-resize", { bubbles: true }));
            }
            return;
        }
        if (type === "send") {
            this.dispatchEvent(
                new CustomEvent<Json>(GUI_SEND_EVENT, {
                    detail: data.data,
                    bubbles: true,
                    composed: true,
                }),
            );
            return;
        }
        if (type === "blur") {
            // The GUI asks for the focus back (buche.blur()).
            this.focus();
            return;
        }
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
