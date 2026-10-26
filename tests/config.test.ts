// @vitest-environment node

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { type Context, frameChords, parseCondition, resolveBindings } from "../src/config.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const NAV = { key: "alt+q", action: "setMode", args: { mode: "nav", hold: "alt" } };

const resolve = (bindings: unknown, mac = false) => resolveBindings([{ bindings }], mac);
/** The rules' keys and actions, compactly. */
const summary = (bindings: unknown[], mac = false) =>
    resolve([NAV, ...bindings], mac)
        .rules.slice(1)
        .map((r) => `${r.keys.join(" ")} ${r.action}`);

describe("conditions", () => {
    const ctx = (c: Partial<Context>): Context => ({
        mode: "",
        inPrompt: false,
        inPTY: false,
        inFrame: false,
        ...c,
    });

    test.each([
        ["mode == nav", { mode: "nav" }, true],
        ["mode == nav", {}, false],
        ["mode != nav", { mode: "move" }, true],
        ["mode", {}, false],
        ["!mode", {}, true],
        ["inPrompt && !mode", { inPrompt: true }, true],
        ["inPrompt && !mode", { inPrompt: true, mode: "nav" }, false],
        ["inPTY || inFrame", { inFrame: true }, true],
        ["!(inPTY || inFrame)", { inFrame: true }, false],
        ["mode == 'nav' && (inPrompt || inPTY)", { mode: "nav", inPTY: true }, true],
    ])("%s with %o: %s", (text, c, expected) => {
        expect(parseCondition(text).test(ctx(c))).toBe(expected);
    });

    test.each([
        ["inPrompts", "unknown context"],
        ["mode ==", "expected a value"],
        ["(inPrompt", "expected )"],
        ["inPrompt inPTY", 'unexpected "inPTY"'],
        ["inPrompt &&", "unexpected end"],
    ])("bad: %s", (text, message) => {
        expect(() => parseCondition(text)).toThrow(message);
    });

    test("the modes named", () => {
        const c = parseCondition("mode == nav || mode == move && inPrompt");
        expect(c.usesMode).toBe(true);
        expect(c.modes).toEqual(["nav", "move"]);
    });
});

describe("resolveBindings", () => {
    test("keys: chords and sequences, in the canonical form", () => {
        expect(
            summary([
                { key: "ctrl+shift+tab", action: "prevTab" },
                { key: "mod+p", action: "focusPrompt" },
                { key: "left", action: "focusLeft", when: "mode == nav" },
                { key: "shift+,", action: "parent", when: "mode == nav" },
                { key: "i shift+up", action: "insertUp", when: "mode == nav" },
                { key: "Alt+KeyQ ArrowLeft", action: "undo" },
            ]),
        ).toEqual([
            "Shift+Ctrl+Tab prevTab",
            "Ctrl+KeyP focusPrompt",
            "ArrowLeft focusLeft",
            "Shift+Comma parent",
            "KeyI Shift+ArrowUp insertUp",
            "Alt+KeyQ ArrowLeft undo",
        ]);
        expect(summary([{ key: "mod+p", action: "focusPrompt" }], true)).toEqual([
            "Meta+KeyP focusPrompt",
        ]);
    });

    test("modes", () => {
        const { rules, errors } = resolve([
            NAV,
            {
                key: "ctrl+e",
                action: "setMode",
                args: { mode: "move", hold: "ctrlright", sticky: "never" },
            },
        ]);
        expect(errors).toEqual([]);
        expect(rules.map((r) => r.mode)).toEqual([
            { name: "nav", hold: "Alt", side: "either", code: "KeyQ", sticky: "repeat" },
            { name: "move", hold: "Ctrl", side: "right", code: "KeyE", sticky: "never" },
        ]);
    });

    test.each([
        [{ key: "alt+q", action: "frobnicate" }, 'unknown action "frobnicate"'],
        [{ action: "nextTab" }, "no key"],
        [{ key: "alt+q" }, "no action"],
        [{ key: "alt+q", action: "nextTab", whne: "x" }, 'unknown field "whne"'],
        [{ key: "alt+nope", action: "nextTab" }, '"nope" is not a key'],
        [{ key: "altleft+q", action: "nextTab" }, "a modifier's side is for setMode's hold"],
        [{ key: "q", action: "nextTab" }, "needs a mode"],
        [{ key: "q", action: "nextTab", when: "inPrompt" }, "needs a mode"],
        [{ key: "alt+q", action: "nextTab", when: "inPrompts" }, 'unknown context "inPrompts"'],
        [{ key: "alt+q", action: "nextTab", args: 3 }, "args: expected a table"],
        [{ key: "alt+e", action: "setMode", args: { hold: "alt" } }, "args.mode"],
        [{ key: "alt+e", action: "setMode", args: { mode: "m" } }, "args.hold"],
        [{ key: "alt+e", action: "setMode", args: { mode: "m", hold: "ctrl" } }, "the one held"],
        [
            { key: "ctrl+alt+e", action: "setMode", args: { mode: "m", hold: "alt" } },
            "the one held",
        ],
        [
            { key: "alt+e x", action: "setMode", args: { mode: "m", hold: "alt" } },
            "not a sequence",
        ],
        [
            { key: "alt+e", action: "setMode", args: { mode: "m", hold: "alt", sticky: "yes" } },
            "sticky",
        ],
        [
            { key: "alt+e", action: "focusLeft", when: "mode == mvoe" },
            'no rule enters the mode "mvoe"',
        ],
        ["alt+e", "expected { key, action, when, args }"],
    ])("bad: %o", (entry, message) => {
        const { errors } = resolve([NAV, entry]);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain(message);
    });

    test("bindings must be a list", () => {
        expect(resolve({ "alt+q": "nextTab" }).errors[0]).toContain("expected a list");
    });

    test("no mode left: Alt+Q for nav", () => {
        const { rules, errors } = resolve([
            { key: "left", action: "focusLeft", when: "mode == nav" },
        ]);
        expect(errors).toEqual(["bindings: no rule enters a mode (setMode): using Alt+Q for nav"]);
        expect(rules[0]).toMatchObject({
            action: "setMode",
            keys: ["Alt+KeyQ"],
            mode: { name: "nav" },
        });
    });

    test("layers: concatenated, a removal taking out what's before it", () => {
        const defaults = {
            bindings: [
                NAV,
                { key: "ctrl+l", action: "clearPrompt", when: "inPrompt" },
                { key: "ctrl+tab", action: "nextTab" },
                { key: "mod+right", action: "nextTab" },
                { key: "k", action: "kill", when: "mode == nav" },
                { key: "t", action: "kill", when: "inPTY && mode == nav" },
            ],
        };
        const user = {
            bindings: [
                { key: "ctrl+tab", action: "-nextTab" },
                { action: "-kill", when: "mode == nav" },
                { key: "ctrl+l", action: "clearPrompt" },
            ],
        };
        const { rules, errors } = resolveBindings([defaults, user], false);
        expect(errors).toEqual([]);
        expect(
            rules.map((r) => `${r.keys.join(" ")} ${r.action} ${r.when?.text ?? ""}`.trim()),
        ).toEqual([
            "Alt+KeyQ setMode",
            "Ctrl+KeyL clearPrompt inPrompt",
            "Ctrl+ArrowRight nextTab",
            "KeyT kill inPTY && mode == nav",
            "Ctrl+KeyL clearPrompt",
        ]);
    });

    test("layers: errors in the defaults say so", () => {
        const { errors } = resolveBindings(
            [{ bindings: [NAV, { key: "q", action: "kill" }] }, {}],
            false,
        );
        expect(errors).toEqual([
            "bindings[1] (in the defaults) (q): a key without Ctrl, Alt or Cmd needs a mode (when: mode == ...)",
        ]);
    });

    test("frameChords: the rules that can apply in a frame", () => {
        const { rules } = resolve([
            NAV,
            { key: "ctrl+p", action: "focusPrompt" },
            { key: "ctrl+l", action: "clearPrompt", when: "inPrompt" },
            { key: "ctrl+k", action: "kill", when: "inFrame" },
            { key: "ctrl+j", action: "kill", when: "!inFrame" },
            { key: "ctrl+i f", action: "insertFloat" },
            { key: "left", action: "focusLeft", when: "mode == nav" },
        ]);
        expect(frameChords(rules)).toEqual(["Alt+KeyQ", "Ctrl+KeyP", "Ctrl+KeyK", "Ctrl+KeyI"]);
    });

    test("the default configuration has no errors", () => {
        const json = execFileSync(
            "bun",
            [
                "-e",
                "console.log(JSON.stringify(Bun.YAML.parse(await Bun.file('config/default.yaml').text())))",
            ],
            { cwd: root, encoding: "utf8" },
        );
        for (const mac of [true, false]) {
            expect(resolveBindings([JSON.parse(json)], mac).errors).toEqual([]);
        }
    });
});

describe("the user's configuration file", () => {
    /** Run user-config.ts's `fn` with $XDG_CONFIG_HOME in a fresh directory. */
    function withConfigHome(test: (home: string, run: (fn: string) => string) => void) {
        const home = mkdtempSync(join(tmpdir(), "buche-config-"));
        const run = (fn: string) =>
            execFileSync(
                "bun",
                ["-e", `const m = await import("./scripts/user-config.ts"); m.${fn}();`],
                { cwd: root, encoding: "utf8", env: { ...process.env, XDG_CONFIG_HOME: home } },
            );
        try {
            test(home, run);
        } finally {
            rmSync(home, { recursive: true, force: true });
        }
    }
    const defaults = readFileSync(join(root, "config/default.yaml"), "utf8");
    const parse = (path: string) =>
        JSON.parse(
            execFileSync(
                "bun",
                [
                    "-e",
                    `console.log(JSON.stringify(Bun.YAML.parse(await Bun.file(${JSON.stringify(path)}).text())))`,
                ],
                { encoding: "utf8" },
            ),
        );

    test("is made from the defaults, commented out", () => {
        withConfigHome((home, run) => {
            run("loadUserConfig");
            const path = join(home, "buche/config.yaml");
            const text = readFileSync(path, "utf8");
            expect(text.split("\n").every((line) => /^\s*(#|$)/.test(line))).toBe(true);
            expect(text).toContain("# bindings:\n");
            expect(text).toContain(
                "#   - { key: alt+q, action: setMode, args: { mode: nav, hold: alt } }\n",
            );
            // (Uncommented, it is the defaults.)
            const uncommented = text
                .split("\n")
                .map((l) => l.replace(/^# (?!\s*#)/, ""))
                .join("\n");
            expect(uncommented).toContain(defaults.slice(defaults.indexOf("\nbindings:")));
            expect(parse(path)).toBe(null);
        });
    });

    test("--reset-bindings comments out its bindings, and only them", () => {
        withConfigHome((home, run) => {
            const path = join(home, "buche/config.yaml");
            run("ensureUserConfig");
            writeFileSync(
                path,
                [
                    "# mine",
                    "theme: dark",
                    "bindings:",
                    "  - { key: ctrl+e, action: setMode, args: { mode: nav, hold: ctrl } }",
                    "",
                    "# the end",
                    "other:",
                    "  x: 1",
                    "",
                ].join("\n"),
            );
            run("resetBindings");
            const text = readFileSync(path, "utf8");
            expect(text.startsWith("# mine\ntheme: dark\n# bindings:\n")).toBe(true);
            expect(text).not.toContain("ctrl+e");
            expect(text.endsWith("when: mode == nav }\n\n# the end\nother:\n  x: 1\n")).toBe(true);
            expect(parse(path)).toEqual({ theme: "dark", other: { x: 1 } });
        });
    });

    test("--reset-bindings leaves a file with no bindings of its own alone", () => {
        withConfigHome((home, run) => {
            const path = join(home, "buche/config.yaml");
            run("ensureUserConfig");
            writeFileSync(path, "theme: dark\n");
            run("resetBindings");
            expect(readFileSync(path, "utf8")).toBe("theme: dark\n");
        });
    });
});
