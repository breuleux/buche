// The runtime injected into <buche-gui> iframes: the element side lives in
// buche-gui.tsx. The runtime is stringified into the iframe's document, so it
// must be self-contained: no imports, no outer variables.

// The runtime, run inside the iframe.
export function bucheGuiRuntime(): void {
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
    // The content height, un-floored by the current viewport: an element's
    // scroll height never falls below its own client height, and in dynamic
    // mode the viewport here is sized *by* these reports — trusting the html
    // scroll height alone would make the content grow but never shrink. The
    // body's box plus its margins measures the content directly; the html
    // scroll height only gets to raise it, when it proves the content
    // overflows the body past the viewport.
    let lastHeight = -1;
    const reportHeight = (): void => {
        const body = document.body;
        if (!body) {
            return;
        }
        const style = getComputedStyle(body);
        const margins =
            (Number.parseFloat(style.marginTop) || 0) +
            (Number.parseFloat(style.marginBottom) || 0);
        let h = Math.ceil(body.getBoundingClientRect().height + margins);
        const html = document.documentElement;
        if (html.scrollHeight > html.clientHeight) {
            h = Math.max(h, html.scrollHeight);
        }
        if (h !== lastHeight) {
            lastHeight = h;
            toParent({ [TAG]: "resize", height: h });
        }
    };
    // The <html> element always exists (the runtime runs at the top of the
    // document, before the body is parsed) and grows with the content beyond
    // the viewport; the body (content-sized in dynamic mode) catches the
    // shrinks the html box would floor at the viewport.
    const heightObserver = new ResizeObserver(reportHeight);
    heightObserver.observe(document.documentElement);
    const observeBody = (): void => {
        if (document.body) {
            heightObserver.observe(document.body);
        }
    };
    if (document.readyState === "loading") {
        window.addEventListener("DOMContentLoaded", observeBody, { once: true });
    } else {
        observeBody();
    }

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
        if (kind === "info") {
            // The cell's sizing information (see BucheGui.sendInfo). Kept on
            // `window.bucheInfo` for programs written against the old runtime,
            // and announced as an event so pages can track later updates.
            const info = { ...data } as Record<string, unknown>;
            delete info[TAG];
            (window as any).bucheInfo = info;
            // In fill mode (the cell has a height of its own) the document
            // gets a real height chain, so `height: 100%` layouts work; in
            // dynamic mode it must stay content-sized.
            const fill = info.dynamicHeight === false;
            let fillStyle = document.getElementById("buche-fill");
            if (fill && fillStyle === null) {
                fillStyle = document.createElement("style");
                fillStyle.id = "buche-fill";
                fillStyle.textContent = "html, body { height: 100%; }";
                (document.head ?? document.documentElement).append(fillStyle);
            } else if (!fill && fillStyle !== null) {
                fillStyle.remove();
            }
            window.dispatchEvent(new CustomEvent("buche-info", { detail: info }));
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
    // "The user is done with this GUI": the focus leaves the cell entirely,
    // even a sticky one (unlike blur(), which only escapes the iframe).
    buche.leave = (): void => {
        send({ type: "leave" });
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

export const RUNTIME = `<script>(${bucheGuiRuntime.toString()})();</script>`;

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
