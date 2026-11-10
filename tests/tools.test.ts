// @vitest-environment node

import { describe, expect, test } from "vitest";
import { matchAsset, pickAssets, resolveShellCommand, tagVersion } from "../scripts/tools.ts";
import { resolveShell, type ShellConfig } from "../src/config.ts";

describe("resolveShell", () => {
    test("a command", () => {
        expect(resolveShell([{ shell: "cq" }]).shell).toEqual({ command: "cq" });
    });

    test("a name on $PATH: nothing to install", async () => {
        const defaults = { shell: { command: "cq", github: "a/b", version: "^1" } };
        const { shell } = resolveShell([defaults, { shell: "cq" }]);
        expect(shell).toEqual({ command: "cq" });
        expect(await resolveShellCommand(shell as ShellConfig)).toEqual({ command: "cq" });
    });

    test("the last layer wins, as a whole", () => {
        const defaults = { shell: { command: "cq", github: "a/b", version: "^1" } };
        expect(resolveShell([defaults, { shell: "~/bin/x" }]).shell).toEqual({
            command: "~/bin/x",
        });
        expect(resolveShell([defaults, {}]).shell).toEqual(defaults.shell);
    });

    test("command defaults to the repository's name", () => {
        expect(resolveShell([{ shell: { github: "breuleux/coquille" } }]).shell).toEqual({
            command: "coquille",
            github: "breuleux/coquille",
        });
    });

    test.each([
        [{ github: "nope" }, "OWNER/REPO"],
        [{ command: "x", version: "^1" }, "goes with `github`"],
        [{ command: "x", frob: 1 }, "unknown field"],
        [{ github: "a/b", assets: "x" }, "list of names"],
        [42, "expected a command"],
    ])("errors: %j", (shell, message) => {
        const { shell: resolved, errors } = resolveShell([{ shell: "cq" }, { shell }]);
        expect(resolved).toEqual({ command: "cq" });
        expect(errors[0]).toContain(message);
    });
});

describe("tagVersion", () => {
    test.each([
        ["v0.0.1", "0.0.1"],
        ["1.2.3", "1.2.3"],
        ["coquille/1.2.3", "1.2.3"],
        ["coquille-v1.2.3-rc.1", "1.2.3-rc.1"],
        ["nightly", null],
    ])("%s", (tag, version) => {
        expect(tagVersion(tag)).toBe(version);
    });
});

describe("assets", () => {
    const names = [
        "coquille-aarch64-apple-darwin.tar.xz",
        "coquille-aarch64-apple-darwin.tar.xz.sha256",
        "coquille-x86_64-unknown-linux-musl.tar.xz",
        "coquille-x86_64-unknown-linux-gnu.tar.gz",
        "dist-manifest.json",
        "sel-aarch64-apple-darwin.tar.xz",
        "sha256.sum",
        "source.tar.gz",
        "tool_darwin_universal",
        "tool_linux_arm64",
    ];
    const assets = names.map((name) => ({ name }));
    const pick = (platform: string, arch: string, wanted?: string[]) =>
        pickAssets(assets, wanted, platform, arch).map((a) => a.name);

    test("base names", () => {
        expect(matchAsset(names[0], "darwin", "arm64")).toEqual({ base: "coquille", score: 2 });
        expect(matchAsset("tool_darwin_universal", "darwin", "arm64")?.base).toBe("tool");
        expect(matchAsset("source.tar.gz", "darwin", "arm64")).toBeNull();
        expect(matchAsset(names[1], "darwin", "arm64")).toBeNull();
    });

    test("macOS arm64", () => {
        expect(pick("darwin", "arm64")).toEqual([
            "coquille-aarch64-apple-darwin.tar.xz",
            "sel-aarch64-apple-darwin.tar.xz",
            "tool_darwin_universal",
        ]);
    });

    test("linux x64 prefers musl", () => {
        expect(pick("linux", "x64")).toEqual(["coquille-x86_64-unknown-linux-musl.tar.xz"]);
    });

    test("linux arm64", () => {
        expect(pick("linux", "arm64")).toEqual(["tool_linux_arm64"]);
    });

    test("wanted", () => {
        expect(pick("darwin", "arm64", ["sel"])).toEqual(["sel-aarch64-apple-darwin.tar.xz"]);
    });
});
