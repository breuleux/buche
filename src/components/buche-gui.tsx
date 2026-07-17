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
//   * reports its content height; the element sizes itself to it.
//
// Inside the iframe, scripts get a `buche` API:
//
//   buche(data)            relay `data` to the page (a "gui-send" event)
//   buche.request(data)    same, but returns a Promise resolved by a `response`
//                          command carrying the same `response_id`
//   buche.proc(url)        fetch a `proc://` resource (see below), as a Response
//   buche.blur()           hand the focus back to the page
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
import { normalizeChord } from "../keychord.ts";
import type { Json } from "../types.ts";

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

// The runtime, run inside the iframe. It is stringified into the iframe's
// document, so it must be self-contained: no imports, no outer variables.
function bucheGuiRuntime(): void {
    const TAG = "buche-gui";
    // True when this document itself is served from a registered custom
    // scheme (Electron): native fetch/attributes handle proc:// by themselves.
    const native = location.protocol !== "about:" && location.protocol !== "file:";

    // Indirect eval: `exec` and `register` evaluate caller-supplied code in
    // the iframe's global scope, by design.
    // biome-ignore lint/security/noGlobalEval: user code execution is the feature
    const geval = eval as (source: string) => any;

    const par = window.parent;
    const toParent = (msg: unknown): void => {
        par.postMessage(msg, "*");
    };
    // Relay a payload to the page (surfaces as a "gui-send" event).
    const send = (data: unknown): void => {
        toParent({ [TAG]: "send", data });
    };

    // ── requests & futures ───────────────────────────────────────────────────
    // Futures of `buche.request`, resolved by a `response` command.
    const futures = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void }>();
    // Pending proc requests of the web shim, resolved by a `resolve` command.
    const pendingProc = new Map<string, (r: any) => void>();
    const newId = (): string => Math.random().toString(36).slice(2);

    // ── proc:// resources ────────────────────────────────────────────────────
    const resolveResource = (url: string, opts?: { method?: string }): Promise<any> => {
        const u = new URL(url, "proc://cell/");
        const request_id = newId();
        return new Promise((resolve) => {
            pendingProc.set(request_id, resolve);
            send({
                type: "resolve",
                request_id,
                path: u.pathname,
                params: Object.fromEntries(u.searchParams),
                method: opts?.method ?? "GET",
            });
        });
    };

    const decodeBase64 = (b64: string): Uint8Array => {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) {
            bytes[i] = bin.charCodeAt(i);
        }
        return bytes;
    };

    const toResponse = (r: any): Response => {
        const body = r.encoding === "base64" ? decodeBase64(r.content ?? "") : (r.content ?? "");
        return new Response(body, {
            status: r.status ?? 200,
            headers: r.mimetype ? { "content-type": r.mimetype } : {},
        });
    };

    // Resolve a proc URL to a Response, natively or through the page.
    const procFetch = (url: string, opts?: { method?: string }): Promise<Response> => {
        if (native) {
            return fetch(url, { method: opts?.method ?? "GET" });
        }
        return resolveResource(url, opts).then(toResponse);
    };

    // Blob-URL cache for attribute rewrites (web mode only).
    const blobUrls = new Map<string, Promise<string>>();
    const blobFor = (url: string): Promise<string> => {
        let p = blobUrls.get(url);
        if (!p) {
            p = procFetch(url)
                .then((r) => r.blob())
                .then((b) => URL.createObjectURL(b));
            blobUrls.set(url, p);
        }
        return p;
    };

    // Classify a URL string: the proc URL it denotes, or null for something
    // the real network stack should handle. Relative URLs (unresolvable
    // against about:srcdoc) are proc resources of this cell.
    const asProcUrl = (url: string): string | null => {
        if (url.startsWith("proc:")) {
            return url;
        }
        if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("//")) {
            return null;
        }
        return `proc://cell/${url.replace(/^\/+/, "")}`;
    };

    if (!native) {
        const realFetch = window.fetch.bind(window);
        (window as any).fetch = (input: any, init?: any): Promise<Response> => {
            const url =
                typeof input === "string"
                    ? input
                    : input instanceof Request
                      ? input.url
                      : String(input);
            const proc = asProcUrl(url);
            if (proc === null) {
                return realFetch(input, init);
            }
            return procFetch(proc, { method: init?.method });
        };
        const RealXHR = window.XMLHttpRequest;
        (window as any).XMLHttpRequest = class extends RealXHR {
            open(...args: any[]): void {
                const open = super.open as (...a: any[]) => void;
                const proc = asProcUrl(String(args[1]));
                if (proc === null) {
                    open(...args);
                    return;
                }
                // Rewrite to a blob URL before the real request goes out.
                open(args[0], "about:blank");
                blobFor(proc).then(
                    (href) => {
                        open(args[0], href);
                    },
                    () => {
                        /* leave the request pointed at about:blank */
                    },
                );
            }
        };
    }

    // Rewrite proc: src/href attributes to blob: URLs (web mode).
    const SRC_ATTRS: Record<string, string> = {
        IMG: "src",
        LINK: "href",
        SCRIPT: "src",
        SOURCE: "src",
        VIDEO: "src",
        AUDIO: "src",
        TRACK: "src",
        IFRAME: "src",
    };
    const rewriteOne = (el: Element, attr: string): void => {
        const value = el.getAttribute(attr);
        const url = value ? asProcUrl(value) : null;
        const dataset = (el as HTMLElement).dataset;
        if (url === null || dataset.procRewritten === "1") {
            return;
        }
        dataset.procRewritten = "1";
        blobFor(url).then(
            (href) => {
                el.setAttribute(attr, href);
            },
            () => {
                /* leave the original URL; it will simply fail to load */
            },
        );
    };
    const rewriteProcUrls = (root: Element): void => {
        if (native) {
            return;
        }
        for (const [tag, attr] of Object.entries(SRC_ATTRS)) {
            if (root.tagName === tag) {
                rewriteOne(root, attr);
            }
            for (const el of Array.from(root.querySelectorAll(tag))) {
                rewriteOne(el, attr);
            }
        }
    };
    new MutationObserver((records) => {
        for (const record of records) {
            for (const node of Array.from(record.addedNodes)) {
                if (node instanceof Element) {
                    rewriteProcUrls(node);
                }
            }
        }
    }).observe(document.documentElement, { childList: true, subtree: true });

    // ── height reporting ─────────────────────────────────────────────────────
    let lastHeight = -1;
    const reportHeight = (): void => {
        const h = Math.max(
            document.documentElement.scrollHeight,
            document.body?.scrollHeight ?? 0,
        );
        if (h !== lastHeight) {
            lastHeight = h;
            toParent({ [TAG]: "resize", height: h });
        }
    };
    // The <html> element always exists (the runtime runs at the top of the
    // document, before the body is parsed); its box grows with the content.
    new ResizeObserver(reportHeight).observe(document.documentElement);

    // ── HTML injection ───────────────────────────────────────────────────────
    // innerHTML / insertAdjacentHTML don't execute scripts — re-create them so
    // they run.
    const runScripts = (root: HTMLElement): void => {
        for (const s of Array.from(root.querySelectorAll("script"))) {
            const ns = document.createElement("script");
            for (const a of Array.from(s.attributes)) {
                ns.setAttribute(a.name, a.value);
            }
            ns.textContent = s.textContent;
            s.replaceWith(ns);
        }
    };

    // Parse content into a detached div, activate scripts, then move nodes
    // into the live DOM so scripts execute exactly once on insertion.
    const apply = (target: HTMLElement, mode: string, content: string): Element[] => {
        const tmp = document.createElement("div");
        tmp.innerHTML = content;
        runScripts(tmp);
        const nodes = Array.from(tmp.childNodes) as Element[];
        if (mode === "set") {
            target.innerHTML = "";
            target.append(...nodes);
        } else if (mode === "replace") {
            target.replaceWith(...nodes);
        } else {
            target.append(...nodes);
        }
        return nodes;
    };

    const findPrimeFocus = (nodes: Element[]): HTMLElement | null => {
        for (const node of nodes) {
            if (node.nodeType !== 1) {
                continue;
            }
            if (node.id === "prime-focus") {
                return node as HTMLElement;
            }
            const pf = node.querySelector("#prime-focus");
            if (pf) {
                return pf as HTMLElement;
            }
        }
        return null;
    };

    // ── focus ────────────────────────────────────────────────────────────────
    let last: HTMLElement | null = null;
    const focusInside = (): void => {
        const target = last?.isConnected
            ? last
            : document.querySelector<HTMLElement>("[autofocus], #prime-focus");
        target?.focus();
    };
    document.addEventListener("focusin", (e) => {
        if (e.target instanceof HTMLElement) {
            last = e.target;
        }
    });

    // ── command handlers ─────────────────────────────────────────────────────
    const dataHandlers: Record<string, (data: any) => void> = {
        "buche:plain": (data) => {
            const pre = document.createElement("pre");
            pre.style.cssText = "margin:4px 8px;font-size:12px;white-space:pre-wrap;";
            pre.textContent = JSON.stringify(data, null, 2);
            document.body.append(pre);
        },
        "buche:text": (data) => {
            const pre = document.createElement("pre");
            pre.style.cssText = "margin:4px 8px;font-size:12px;white-space:pre-wrap;";
            pre.textContent = String(data?.text ?? "");
            document.body.append(pre);
        },
    };

    const handlers: Record<string, (msg: any) => unknown> = {
        html(msg: any) {
            const { mode, selector, content } = msg;
            const targets = selector
                ? (Array.from(document.querySelectorAll(selector)) as HTMLElement[])
                : [document.body];
            const added: Element[] = [];
            for (const target of targets) {
                added.push(...apply(target, mode ?? "append", content));
            }
            reportHeight();
            const pf = findPrimeFocus(added);
            pf?.focus();
        },

        async exec(msg: any) {
            const { code, response_id, selector } = msg;
            const targets = selector ? Array.from(document.querySelectorAll(selector)) : [null];
            if (response_id != null) {
                const fn = geval(`(function() { return (${code}); })`);
                try {
                    const value = await Promise.all(targets.map((t) => fn.call(t)));
                    send({ type: "response", response_id, value: selector ? value : value[0] });
                } catch (err: any) {
                    send({ type: "response", response_id, error: String(err) });
                }
            } else {
                const fn = geval(`(function() { ${code} })`);
                targets.forEach((t) => {
                    fn.call(t);
                });
            }
        },

        data(msg: any) {
            const schema = msg.data?.$schema ?? "buche:plain";
            const handler = dataHandlers[schema] ?? dataHandlers["buche:plain"];
            handler(msg.data);
            reportHeight();
        },

        register(msg: any) {
            for (const [type, code] of Object.entries(msg.handlers as Record<string, string>)) {
                handlers[type] = geval(`(${code})`);
            }
        },

        register_schemas(msg: any) {
            for (const [spec, code] of Object.entries(msg.schemas as Record<string, string>)) {
                dataHandlers[spec] = geval(`(${code})`);
            }
        },

        // Answer a pending proc request (web mode; native mode is answered by
        // the preload bridge instead).
        resolve(msg: any) {
            const waiter = pendingProc.get(msg.request_id);
            if (waiter) {
                pendingProc.delete(msg.request_id);
                waiter(msg);
            }
        },

        // Pre-seed the blob cache so a later request is instant.
        cache(msg: any) {
            const url = `proc://cell${msg.path}`;
            if (blobUrls.has(url)) {
                return;
            }
            const body =
                msg.encoding === "base64" ? decodeBase64(msg.content ?? "") : (msg.content ?? "");
            const blob = new Blob([body], { type: msg.mimetype ?? "application/octet-stream" });
            blobUrls.set(url, Promise.resolve(URL.createObjectURL(blob)));
        },

        response(msg: any) {
            const future = futures.get(msg.response_id);
            if (future) {
                futures.delete(msg.response_id);
                if (msg.error != null) {
                    future.reject(msg.error);
                } else {
                    future.resolve(msg.value);
                }
            }
        },

        focus(_msg: any) {
            focusInside();
        },
    };

    // ── key interception ─────────────────────────────────────────────────────
    // Set by the page each time the focus enters the iframe.
    let chords = new Set<string>();
    // Whether a chord was handed to the page and the focus hasn't left yet.
    let handingOff = false;

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
        toParent({
            [TAG]: type,
            key: e.key,
            code: e.code,
            ctrlKey: e.ctrlKey,
            altKey: e.altKey,
            shiftKey: e.shiftKey,
            metaKey: e.metaKey,
        });
    };

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

    // ── the message loop ─────────────────────────────────────────────────────
    window.addEventListener("message", (e) => {
        if (e.source !== par) {
            return;
        }
        const data = e.data as any;
        if (!data) {
            return;
        }
        const kind = data[TAG];
        if (kind === "config") {
            chords = new Set(data.chords as string[]);
            return;
        }
        if (kind === "focus") {
            focusInside();
            return;
        }
        if (typeof data.type === "string") {
            const handler = handlers[data.type];
            if (handler) {
                handler(data);
            }
        }
    });

    // ── the API for scripts inside the iframe ────────────────────────────────
    const buche = ((data: unknown) => {
        send(data);
    }) as any;
    buche.send = buche;
    buche.request = (data: any): Promise<any> => {
        const response_id = newId();
        const promise = new Promise<any>((resolve, reject) => {
            futures.set(response_id, { resolve, reject });
        });
        send({ ...data, response_id });
        return promise;
    };
    buche.proc = (url: string, opts?: { method?: string }): Promise<Response> => {
        return procFetch(url, opts);
    };
    buche.blur = (): void => {
        toParent({ [TAG]: "blur" });
    };
    buche.autofocus = focusInside;
    (window as any).buche = buche;

    const announceReady = (): void => {
        toParent({ [TAG]: "ready" });
    };
    // Flush queued commands only once the document is fully parsed: the
    // runtime runs at its very top, so `document.body` — the default target
    // of `html` and `data` — only exists at the end of parsing.
    if (document.readyState === "loading") {
        window.addEventListener("DOMContentLoaded", announceReady, { once: true });
    } else {
        announceReady();
    }
}

const RUNTIME = `<script>(${bucheGuiRuntime.toString()})();</script>`;

// Put the runtime first in the document (after the doctype, if any, so the
// document doesn't drop to quirks mode).
function inject(html: string): string {
    const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
    return doctype ? doctype[0] + RUNTIME + html.slice(doctype[0].length) : RUNTIME + html;
}

/** The empty runtime document, served at `proc://<cell-id>/` when the scheme
 *  is registered natively (Electron); content then arrives through `html`
 *  commands. See `electron/proc-protocol.ts`. */
export function guiRuntimeDocument(): string {
    return [
        "<!doctype html>",
        '<html><head><meta charset="utf-8">',
        "<style>html { color-scheme: dark; } body { margin: 0; }</style>",
        `</head><body>${RUNTIME}</body></html>`,
    ].join("");
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

    connectedCallback(): void {
        this.ensureSetup();
        window.addEventListener("message", this.onMessage);
        window.addEventListener("blur", this.onWindowBlur);
    }

    disconnectedCallback(): void {
        window.removeEventListener("message", this.onMessage);
        window.removeEventListener("blur", this.onWindowBlur);
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
        this.postTagged({ [TAG]: "config", chords: this.interceptChords().map(normalizeChord) });
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
            for (const message of this.queue.splice(0)) {
                this.frame.contentWindow?.postMessage(message, "*");
            }
            return;
        }
        if (type === "resize") {
            this.style.height = `${Math.max(0, Math.ceil(data.height as number))}px`;
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
