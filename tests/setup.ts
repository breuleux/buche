// Every test's BucheInterface gets the default configuration
// (config/default.yaml), unless it is given one. Vitest runs on Node, which
// has no YAML parser: Bun (which the launchers need anyway) parses it.

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// (Paths by hand: under happy-dom, `URL` is the DOM's.)
const path = join(dirname(fileURLToPath(import.meta.url)), "../config/default.yaml");
const json = execFileSync(
    "bun",
    [
        "-e",
        "process.stdout.write(JSON.stringify(Bun.YAML.parse(await Bun.file(Bun.argv.at(-1)).text())))",
        path,
    ],
    { encoding: "utf8" },
);
// (Not in the tests without a DOM, where the interface can't be loaded.)
if (typeof HTMLElement !== "undefined") {
    const { BucheInterface } = await import("../src/interface.tsx");
    BucheInterface.defaultConfig = JSON.parse(json);
}
