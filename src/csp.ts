// No network for GUI cells: the Content Security Policy every GUI document
// gets, so that a page (and every library it loads) reaches nothing but its
// process (`proc:`), its libraries (`lib:`) and what it makes itself (`blob:`,
// `data:`). Anything over http(s) or ws(s) is refused; a library that tries
// fails, by design.
//
// Where it is applied:
//   * Electron: as a response header on the `proc://<cell>/` runtime document
//     (electron/proc-protocol.ts), backed by a webRequest block on every
//     http(s)/ws(s) request from a GUI frame (electron/main.ts), which also
//     covers a frame navigating itself, which CSP cannot stop.
//   * Web: as a `<meta>` first thing in each `srcdoc` document (see `inject`
//     in src/components/buche-gui.tsx), plus OUTER_PAGE_CSP on the page
//     embedding them (scripts/view.ts): a parent's `frame-src` governs its
//     frames' navigations, so a GUI frame can't navigate itself off to the
//     internet either.
//
// A policy can't be loosened once applied: removing the `<meta>` does nothing,
// and a policy added later can only restrict further. Frames made from a GUI
// (`srcdoc`, `blob:`) inherit it.
//
// Not covered: WebRTC (no CSP directive; see electron/main.ts for what
// Electron can narrow) and DNS prefetch hints (a lookup, no payload).

/**
 * The policy for a GUI document. `libBase` is where `lib://` files are served
 * over HTTP in web mode (BucheGui.libBase, e.g. "http://localhost:1234/lib/"):
 * allowed besides the `lib:` scheme itself. `'unsafe-inline'` and
 * `'unsafe-eval'` are needed: the `html` command re-creates inline scripts,
 * and `exec` / `register` / `register_schemas` evaluate code. There is no
 * `report-uri`: reports would be requests too.
 */
export function guiCsp(libBase: string | null = null): string {
    const local = ["proc:", "lib:", "blob:", "data:", ...(libBase ? [libBase] : [])].join(" ");
    return [
        "default-src 'none'",
        `script-src 'unsafe-inline' 'unsafe-eval' ${local}`,
        `style-src 'unsafe-inline' ${local}`,
        `img-src ${local}`,
        `font-src ${local}`,
        `media-src ${local}`,
        `connect-src ${local}`,
        `worker-src ${local}`,
        // Not data: (a data: document may not inherit this policy); srcdoc
        // frames are not subject to frame-src.
        "frame-src proc: blob:",
        "form-action 'none'",
        "base-uri 'none'",
    ].join("; ");
}

/** The policy as a `<meta>` element, for the head of a `srcdoc` document. */
export function guiCspMeta(libBase: string | null = null): string {
    return `<meta http-equiv="Content-Security-Policy" content="${guiCsp(libBase)}">`;
}

/**
 * The policy of the page embedding GUI frames over the web: only its
 * `frame-src` matters, which (inherited by the `srcdoc` frames, and checked
 * against their navigations) keeps them on the page's own origin and `blob:`.
 */
export const OUTER_PAGE_CSP = "frame-src 'self' blob:";
