import { describe, expect, it } from "vitest";
import { BucheGui, inject } from "../src/components/buche-gui.tsx";
import { guiCsp, guiCspMeta, OUTER_PAGE_CSP } from "../src/csp.ts";

/** The policy as directive → sources. */
function directives(policy: string): Map<string, string[]> {
    return new Map(
        policy.split(";").map((d) => {
            const [name, ...sources] = d.trim().split(/\s+/);
            return [name, sources];
        }),
    );
}

describe("the GUI policy", () => {
    it("denies by default and allows no network source", () => {
        const policy = directives(guiCsp());
        expect(policy.get("default-src")).toEqual(["'none'"]);
        for (const [name, sources] of policy) {
            for (const source of sources) {
                expect(source, `${name} ${source}`).not.toMatch(/^(https?|wss?):|^\*|^'self'$/);
            }
        }
        // What the protocol needs: inline scripts (html), eval (exec,
        // register), proc: and lib: resources, blob: (the web proc shim).
        expect(policy.get("script-src")).toEqual(
            expect.arrayContaining(["'unsafe-inline'", "'unsafe-eval'", "proc:", "lib:", "blob:"]),
        );
        expect(policy.get("connect-src")).toEqual(expect.arrayContaining(["proc:", "lib:"]));
        expect(policy.get("frame-src")).not.toContain("data:");
        expect(policy.has("report-uri")).toBe(false);
    });

    it("allows the web library server, and only it, when given", () => {
        const base = "http://localhost:1234/lib/";
        const policy = directives(guiCsp(base));
        for (const name of ["script-src", "style-src", "img-src", "font-src", "connect-src"]) {
            expect(policy.get(name)).toContain(base);
        }
        expect(guiCsp(base).replaceAll(base, "")).not.toMatch(/https?:/);
    });

    it("keeps the outer page's frames on its own origin", () => {
        expect(OUTER_PAGE_CSP).toBe("frame-src 'self' blob:");
    });
});

describe("srcdoc documents", () => {
    it("start with the policy, before the runtime and the content", () => {
        const html = inject("<p>hi</p><script>fetch('x')</script>");
        expect(html.startsWith(guiCspMeta(BucheGui.libBase))).toBe(true);
        expect(html.endsWith("<p>hi</p><script>fetch('x')</script>")).toBe(true);
    });

    it("keep their doctype first, then the policy", () => {
        const html = inject("<!doctype html><p>hi</p>");
        expect(html.startsWith(`<!doctype html>${guiCspMeta(BucheGui.libBase)}`)).toBe(true);
    });

    it("allow the library server in web mode", () => {
        const saved = BucheGui.libBase;
        BucheGui.libBase = "http://localhost:1234/lib/";
        try {
            expect(inject("")).toContain(
                `connect-src proc: lib: blob: data: http://localhost:1234/lib/`,
            );
        } finally {
            BucheGui.libBase = saved;
        }
    });
});
