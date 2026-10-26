// @vitest-environment happy-dom
// @vitest-environment-options { "url": "about:blank", "settings": { "disableJavaScriptFileLoading": true, "disableCSSFileLoading": true, "handleDisabledFileLoadingAsSuccess": true } }
// The GUI runtime's handling of lib:// URLs in srcdoc (web) mode: rewritten
// to BucheGui.libBase, in `html` content before insertion, in fetch, and
// through buche.lib(). (The runtime runs in this test's own window, which
// stands for the iframe: it is its own parent, and not a native document.)

import { beforeAll, expect, test } from "vitest";
import { bucheGuiRuntime } from "../src/components/buche-gui-runtime.ts";

const BASE = "http://localhost:1234/lib/";
const fetched: string[] = [];

beforeAll(() => {
    (window as any).__bucheLibBase = BASE;
    (window as any).fetch = async (url: unknown) => {
        fetched.push(String(url));
        return new Response("ok");
    };
    bucheGuiRuntime();
});

const command = (data: unknown) =>
    window.dispatchEvent(new MessageEvent("message", { source: window, data }));

test("html content: lib: attributes are rewritten before insertion", () => {
    command({
        type: "html",
        mode: "set",
        content: [
            '<link rel="stylesheet" href="lib://abcdefabcdefabcdef/style.css">',
            '<img src="LIB://abcdefabcdefabcdef/a%20b.png">',
            '<script type="module" src="lib://abcdefabcdefabcdef/js/main.js"></script>',
            '<img src="https://example.com/x.png">',
        ].join(""),
    });
    expect(document.querySelector("link")?.getAttribute("href")).toBe(
        `${BASE}abcdefabcdefabcdef/style.css`,
    );
    expect(document.querySelector("img")?.getAttribute("src")).toBe(
        `${BASE}abcdefabcdefabcdef/a%20b.png`,
    );
    expect(document.querySelector("script")?.getAttribute("src")).toBe(
        `${BASE}abcdefabcdefabcdef/js/main.js`,
    );
    expect(document.querySelectorAll("img")[1]?.getAttribute("src")).toBe(
        "https://example.com/x.png",
    );
});

test("fetch and buche.lib", async () => {
    await fetch("lib://abcdefabcdefabcdef/data.json");
    expect(fetched).toContain(`${BASE}abcdefabcdefabcdef/data.json`);
    const buche = (window as any).buche;
    expect(buche.lib("lib://abcdefabcdefabcdef/x.js")).toBe(`${BASE}abcdefabcdefabcdef/x.js`);
    expect(buche.lib("https://example.com/x.js")).toBe("https://example.com/x.js");
});
