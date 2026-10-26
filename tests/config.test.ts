// @vitest-environment node

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { resolveBindings } from "../src/config.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const resolve = (
    bindings: Record<string, unknown>,
    modifiers: Record<string, unknown> | undefined = { Nav: "Alt+q" },
    mac = false,
) => resolveBindings([{ modifiers, bindings }], mac);

const mode = (modifiers: Record<string, unknown>, name = "Nav") =>
    resolve({}, modifiers).bindings.modes[name];

describe("resolveBindings", () => {
    test("a modifier's chord", () => {
        const { bindings, errors } = resolve({}, { Nav: "Ctrl+Space" });
        expect(errors).toEqual([]);
        expect(bindings.modes).toEqual({
            Nav: {
                modifier: "Control",
                code: "Space",
                side: "either",
                chord: "Ctrl+space",
                bindings: {},
                prefixes: {},
            },
        });
    });

    test("a modifier's chord, on one side", () => {
        expect(mode({ Nav: "AltLeft+q" })).toMatchObject({
            modifier: "Alt",
            code: "KeyQ",
            side: "left",
        });
        expect(mode({ Nav: "RightCmd+;" })).toMatchObject({
            modifier: "Meta",
            code: "Semicolon",
            side: "right",
            chord: "Meta+;",
        });
    });

    test.each([
        ["q", "exactly one modifier"],
        ["Ctrl+Alt+q", "exactly one modifier"],
        ["Alt", "the key is missing"],
        ["Alt+nope", "is not a key"],
    ])("a bad chord (%s), and no other modifier: Nav is Alt+q", (chord, message) => {
        const { bindings, errors } = resolve({}, { Nav: chord });
        expect(errors).toHaveLength(2);
        expect(errors[0]).toContain(message);
        expect(errors[1]).toContain("none defined");
        expect(Object.keys(bindings.modes)).toEqual(["Nav"]);
        expect(bindings.modes.Nav).toMatchObject({ modifier: "Alt", code: "KeyQ" });
    });

    test("no modifiers section: Nav is Alt+q", () => {
        const { bindings, errors } = resolve({ "Nav+Left": "focusLeft" }, {});
        expect(errors).toEqual(["modifiers: none defined (using Nav: Alt+q)"]);
        expect(bindings.modes.Nav).toMatchObject({
            code: "KeyQ",
            bindings: { ArrowLeft: "focusLeft" },
        });
    });

    test("bad modifier definitions", () => {
        const { bindings, errors } = resolve(
            {},
            {
                Nav: "Alt+q",
                Move: "AltLeft+q",
                Ctrl: "Alt+w",
                "my mode": "Alt+e",
                Mod: "Alt+r",
                Two: "Alt+t",
            },
        );
        expect(errors).toHaveLength(4);
        expect(errors.join("\n")).toMatch(/Move: same chord as Nav/);
        expect(errors.join("\n")).toMatch(/Ctrl: that name is a keyboard modifier's/);
        expect(errors.join("\n")).toMatch(/Mod: that name is a keyboard modifier's/);
        expect(errors.join("\n")).toMatch(/my mode: a modifier's name is a word/);
        expect(Object.keys(bindings.modes)).toEqual(["Nav", "Two"]);
    });

    test("several modifiers: each with its own bindings", () => {
        const { bindings, errors } = resolve(
            {
                "Nav+Left": "focusLeft",
                "Move+Left": "swapLeft",
                "Move+Shift+q": "undo",
                "Move+i": { Enter: "insert" },
            },
            { Nav: "Alt+q", Move: "Ctrl+e" },
        );
        expect(errors).toEqual([]);
        expect(bindings.modes.Nav).toMatchObject({
            bindings: { ArrowLeft: "focusLeft" },
            prefixes: {},
        });
        expect(bindings.modes.Move).toMatchObject({
            modifier: "Control",
            code: "KeyE",
            bindings: { ArrowLeft: "swapLeft", "Shift+KeyQ": "undo" },
            prefixes: { KeyI: { Enter: "insert" } },
        });
    });

    test("bindings in an undefined mode, or a mode's chord in bindings", () => {
        const { errors } = resolve({ "Move+Left": "focusLeft", Nav: "Alt+q" });
        expect(errors).toHaveLength(2);
        expect(errors[0]).toMatch(
            /Move\+Left: "Move" is not a modifier \(define it under modifiers:\)/,
        );
        expect(errors[1]).toMatch(/Nav: .*define it under modifiers:/);
    });

    test("bindings and prefixes, by key code", () => {
        const { bindings, errors } = resolve({
            "Nav+Left": "focusLeft",
            "Nav+Shift+,": "parent",
            "Nav+]": "growHeight",
            "Nav+k": "kill",
            "Nav+i": { Enter: "insert", "Shift+Up": "insertUp", f: "insertFloat" },
        });
        expect(errors).toEqual([]);
        expect(bindings.modes.Nav.bindings).toEqual({
            ArrowLeft: "focusLeft",
            "Shift+Comma": "parent",
            BracketRight: "growHeight",
            KeyK: "kill",
        });
        expect(bindings.modes.Nav.prefixes).toEqual({
            KeyI: { Enter: "insert", "Shift+ArrowUp": "insertUp", KeyF: "insertFloat" },
        });
    });

    test("bad mode bindings are reported and left out", () => {
        const { bindings, errors } = resolve({
            "Nav+q": "undo",
            "Nav+Alt+x": "undo",
            "Nav+y": "frobnicate",
            "Nav+s": { Left: "swapLeft", Right: "nope" },
            "Nav+u": null,
        });
        expect(errors).toHaveLength(4);
        expect(errors.join("\n")).toMatch(/Nav\+q: .*toggles the mode/);
        expect(errors.join("\n")).toMatch(/Nav\+Alt\+x: Alt is the mode's modifier/);
        expect(errors.join("\n")).toMatch(/Nav\+y: unknown navigation action "frobnicate"/);
        expect(errors.join("\n")).toMatch(/Nav\+s Right: unknown navigation action "nope"/);
        expect(bindings.modes.Nav.bindings).toEqual({});
        expect(bindings.modes.Nav.prefixes).toEqual({ KeyS: { ArrowLeft: "swapLeft" } });
    });

    test("global bindings, with Mod by platform", () => {
        const spec = { "Mod+p": "focusPrompt", "Ctrl+Shift+Tab": "prevTab" };
        expect(resolve(spec, undefined, true).bindings.global).toEqual({
            "Meta+p": "focusPrompt",
            "Shift+Ctrl+Tab": "prevTab",
        });
        expect(resolve(spec, { Nav: "Alt+q" }, false).bindings.global).toEqual({
            "Ctrl+p": "focusPrompt",
            "Shift+Ctrl+Tab": "prevTab",
        });
        expect(
            resolve({ "Mod+Right": "nextTab" }, { Nav: "Alt+q" }, true).bindings.global,
        ).toEqual({
            "Meta+ArrowRight": "nextTab",
        });
    });

    test("bad global bindings are reported and left out", () => {
        const { bindings, errors } = resolve({
            p: "focusPrompt",
            "Shift+p": "focusPrompt",
            "Ctrl+p": "focusLeft",
            "CtrlLeft+p": "focusPrompt",
            "Alt+q": "nextTab",
            F5: "nextTab",
        });
        expect(errors).toHaveLength(5);
        expect(errors[4]).toMatch(/Alt\+q: that chord enters the Nav mode/);
        expect(bindings.global).toEqual({ F5: "nextTab" });
    });

    test("layers: the user's over the defaults", () => {
        const defaults = {
            modifiers: { Nav: "Alt+q" },
            bindings: {
                "Mod+p": "focusPrompt",
                "Ctrl+l": "clearPrompt",
                "Nav+Comma": "prevTab",
                "Nav+k": "kill",
                "Nav+u": "unexpand",
                "Nav+s": { Left: "swapLeft", Right: "swapRight" },
                "Nav+i": { Enter: "insert" },
            },
        };
        const user = {
            modifiers: { Move: "Ctrl+e" },
            bindings: {
                // The same chords, written otherwise.
                "Cmd+p": "nextTab",
                "Nav+,": "nextTab",
                "Nav+k": null,
                "Nav+s": { Right: null, Up: "swapUp" },
                "Nav+i": "insert",
                "Ctrl+l": null,
                "Move+Left": "moveLeft",
            },
        };
        const { bindings, errors } = resolveBindings([defaults, user], true);
        expect(errors).toEqual([]);
        expect(Object.keys(bindings.modes)).toEqual(["Nav", "Move"]);
        expect(bindings.global).toEqual({ "Meta+p": "nextTab" });
        expect(bindings.modes.Nav.bindings).toEqual({
            Comma: "nextTab",
            KeyU: "unexpand",
            KeyI: "insert",
        });
        expect(bindings.modes.Nav.prefixes).toEqual({
            KeyS: { ArrowLeft: "swapLeft", ArrowUp: "swapUp" },
        });
        expect(bindings.modes.Move.bindings).toEqual({ ArrowLeft: "moveLeft" });
    });

    test("layers: within one, the last of a chord's spellings wins", () => {
        const { bindings } = resolveBindings(
            [
                {
                    modifiers: { Nav: "Alt+q" },
                    bindings: { "Nav+,": "prevTab", "Nav+Comma": "nextTab" },
                },
            ],
            false,
        );
        expect(bindings.modes.Nav.bindings).toEqual({ Comma: "nextTab" });
    });

    test("layers: a modifier overridden in place, or removed with its bindings", () => {
        const defaults = {
            modifiers: { Nav: "Alt+q", Move: "Alt+w" },
            bindings: { "Nav+k": "kill", "Move+Left": "moveLeft" },
        };
        const over = resolveBindings([defaults, { modifiers: { Nav: "Ctrl+e" } }], false);
        expect(over.errors).toEqual([]);
        expect(Object.keys(over.bindings.modes)).toEqual(["Nav", "Move"]);
        expect(over.bindings.modes.Nav).toMatchObject({
            code: "KeyE",
            bindings: { KeyK: "kill" },
        });
        const gone = resolveBindings([defaults, { modifiers: { Move: null } }], false);
        expect(gone.errors).toEqual([]);
        expect(Object.keys(gone.bindings.modes)).toEqual(["Nav"]);
    });

    test("layers: a default made wrong by the user's is reported as the default's", () => {
        const { bindings, errors } = resolveBindings(
            [
                { modifiers: { Nav: "Alt+q" }, bindings: { "Nav+k": "kill" } },
                { modifiers: { Nav: "Alt+k" } },
            ],
            false,
        );
        expect(errors).toEqual([
            "bindings: Nav+k: this key toggles the mode, it can't be bound (in the defaults)",
        ]);
        expect(bindings.modes.Nav.bindings).toEqual({});
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

    const commentedOut = (text: string) =>
        text.split("\n").every((line) => /^\s*(#|$)/.test(line));

    test("is made from the defaults, commented out", () => {
        withConfigHome((home, run) => {
            run("loadUserConfig");
            const text = readFileSync(join(home, "buche/config.yaml"), "utf8");
            expect(commentedOut(text)).toBe(true);
            expect(text).toContain("# modifiers:\n#   Nav: Alt+q\n");
            expect(text).toContain("#   Nav+Left: focusLeft\n");
            // (Uncommented, it is the defaults.)
            const uncommented = text
                .split("\n")
                .map((l) => l.replace(/^# (?!\s*#)/, ""))
                .join("\n");
            expect(uncommented).toContain(defaults.slice(defaults.indexOf("modifiers:")));
        });
    });

    test("--reset-bindings comments out its modifiers and bindings, and only them", () => {
        withConfigHome((home, run) => {
            const path = join(home, "buche/config.yaml");
            run("ensureUserConfig");
            writeFileSync(
                path,
                [
                    "# mine",
                    "theme: dark",
                    "modifiers:",
                    "  Nav: Ctrl+e",
                    "  Move: Ctrl+w",
                    "bindings:",
                    "  Nav+Left: focusRight",
                    "",
                    "# the end",
                    "other:",
                    "  x: 1",
                    "",
                ].join("\n"),
            );
            run("resetBindings");
            const text = readFileSync(path, "utf8");
            expect(
                text.startsWith(
                    "# mine\ntheme: dark\n# modifiers:\n#   Nav: Alt+q\n# bindings:\n",
                ),
            ).toBe(true);
            expect(text).not.toContain("Ctrl+e");
            expect(text).not.toContain("Ctrl+w");
            expect(
                text.endsWith("#     Shift+Down: moveDown\n\n# the end\nother:\n  x: 1\n"),
            ).toBe(true);
            // What's left of it: the rest.
            const json = execFileSync(
                "bun",
                [
                    "-e",
                    `console.log(JSON.stringify(Bun.YAML.parse(await Bun.file(${JSON.stringify(path)}).text())))`,
                ],
                { encoding: "utf8" },
            );
            expect(JSON.parse(json)).toEqual({ theme: "dark", other: { x: 1 } });
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
