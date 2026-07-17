#!/usr/bin/env node
/**
 * Launch the Electron build of buche — builds dist/electron and runs it.
 * Extra arguments go to scripts/electron.ts (-c CMD, -d DIR, -l LAYOUT, --devtools).
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { status } = spawnSync(
    "bun",
    ["run", join(root, "scripts/electron.ts"), ...process.argv.slice(2)],
    { stdio: "inherit" },
);
process.exit(status ?? 1);
