/**
 * Build the Electron app and run it — rebuild and relaunch in one command.
 *
 *   bun run electron [-c COMMAND] [-d DIR] [-l LAYOUT] [--devtools] [--print-messages]
 *
 * Options:
 *   -c, --command COMMAND   Shell command driving the session. Default: cq.
 *   -d, --dir DIR           Working directory for that process.
 *   -l, --layout FILE       HTML layout seeding the interface zones.
 *                           Default: layouts/standard.html.
 *       --devtools          Open the window's devtools on start.
 *       --print-messages    Print the incoming/outgoing driver messages on
 *                           stdout (hidden by default).
 *
 * Everything is bundled into dist/electron (main, preload, renderer, the page
 * with the component stylesheets inlined, and the GUI runtime document served
 * at proc://…/), then Electron is started on it. Each run opens a new window;
 * instances already running are left alone. The window dies with this script —
 * Ctrl+C through the shared process group, or the ppid check in
 * electron/main.ts when the script exits by other means.
 *
 * The renderer is the browser client of scripts/view.ts with the WebSocket
 * replaced by the preload's IPC bridge; the driver process lives in the main
 * process (see electron/main.ts).
 *
 * One-time setup: Electron's install script (which unpacks the binary) is not
 * run by default by bun — `bun pm trust electron`, or `bun run electron` will
 * die with "Electron failed to install correctly".
 */
import "./dom-setup.ts";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { guiRuntimeDocument } from "../src/components/buche-gui.tsx";

const scriptDir = dirname(new URL(import.meta.url).pathname);
const root = join(scriptDir, "..");
const outDir = join(root, "dist/electron");

const { values } = parseArgs({
    options: {
        command: { type: "string", short: "c" },
        dir: { type: "string", short: "d" },
        layout: { type: "string", short: "l" },
        devtools: { type: "boolean" },
        "print-messages": { type: "boolean" },
    },
});

const layoutPath = values.layout ?? join(root, "layouts/standard.html");
const layout = readFileSync(layoutPath, "utf8");
const componentsDir = join(root, "src/components");

/** `components.css` with every `@import` inlined, recursively. */
function stylesheet(file: string, seen = new Set<string>()): string {
    const path = join(componentsDir, file);
    if (seen.has(path)) {
        return "";
    }
    seen.add(path);
    return readFileSync(path, "utf8").replace(
        /^\s*@import\s+"([^"]+)";\s*$/gm,
        (_all, ref: string) => stylesheet(ref.replace(/^\.\//, ""), seen),
    );
}

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Buche</title>
<style>
${stylesheet("components.css")}
</style>
<style>
  :root { color-scheme: dark; }
  html, body { margin: 0; height: 100%; }
  body {
    /* Very dark grey. */
    background: #141414;
    color: #d0d0d0;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  #buche { position: fixed; inset: 0; }
  #buche > * { width: 100%; height: 100%; }
</style>
</head>
<body>
<div id="buche">${layout}</div>
<script defer src="renderer.js"></script>
</body>
</html>
`;

/**
 * Bundle one entrypoint. Browser code is an IIFE (the page is a `file://`
 * document, where module scripts are not allowed); main-process code is CJS,
 * written with the `.cjs` extension Electron needs alongside `"type": "module"`.
 */
async function build(entry: string, out: string, browser: boolean): Promise<void> {
    const result = await Bun.build({
        entrypoints: [join(root, entry)],
        outdir: outDir,
        target: browser ? "browser" : "node",
        format: browser ? "iife" : "cjs",
        naming: "[name].[ext]",
        external: ["electron"],
        // `format.ts` ends with an `import.meta.main` CLI guard, meaningless in
        // a CJS bundle (and `import.meta` itself is not CJS).
        define: browser ? {} : { "import.meta.main": "false" },
    });
    if (!result.success) {
        console.error(`buche: ${entry} failed to build:`);
        for (const log of result.logs) {
            console.error(String(log));
        }
        process.exit(1);
    }
    const produced = result.outputs[0].path;
    const target = join(outDir, out);
    if (produced !== target) {
        renameSync(produced, target);
    }
    console.log(`  built ${out}`);
}

rmSync(outDir, { recursive: true, force: true });
console.log("buche (electron): building");
await build("electron/renderer.ts", "renderer.js", true);
await build("electron/preload.ts", "preload.cjs", false);
await build("electron/main.ts", "main.cjs", false);
writeFileSync(join(outDir, "index.html"), page);
// The document the native `proc://<cell-id>/` origin serves (see proc-protocol.ts).
writeFileSync(join(outDir, "runtime.html"), guiRuntimeDocument());

// Spawn the Electron binary directly rather than through node_modules/.bin —
// the .bin entry is a node wrapper that would sit between this process and
// Electron, breaking the ppid check main.ts uses to die with this launcher.
// `path.txt` (at the package root) names the binary inside `dist/`.
const electronPackage = join(root, "node_modules/electron");
const electronBin = join(
    electronPackage,
    "dist",
    readFileSync(join(electronPackage, "path.txt"), "utf8").trim(),
);
const child = Bun.spawn([electronBin, join(outDir, "main.cjs")], {
    stdio: ["inherit", "inherit", "inherit"],
    env: {
        ...process.env,
        BUCHE_ELECTRON: JSON.stringify({
            dir: outDir,
            command: values.command ?? "cq",
            cwd: values.dir,
            parent: process.pid,
            devtools: values.devtools ?? false,
            printMessages: values["print-messages"] ?? false,
        }),
    },
});
console.log(`buche (electron): running ${values.command ?? "cq"} (pid ${child.pid})`);

await child.exited;
