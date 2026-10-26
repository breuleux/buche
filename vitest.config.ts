import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defaultClientConditions } from "vite";
import { configDefaults, defineConfig } from "vitest/config";

const fromRoot = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

const carreauPackage = JSON.parse(
    readFileSync(fromRoot("./node_modules/carreau/package.json"), "utf8"),
) as { version: string };

export default defineConfig({
    // What carreau's own build defines (its sources are compiled here).
    define: { __CARREAU_VERSION__: JSON.stringify(carreauPackage.version) },
    resolve: {
        alias: {
            "myjsx/jsx-runtime": fromRoot("./src/jsx/jsx-runtime.ts"),
            "myjsx/jsx-dev-runtime": fromRoot("./src/jsx/jsx-dev-runtime.ts"),
        },
        // Carreau from its sources (as the Electron build has it), not its
        // build (dist/, which may be stale): in the DOM environments too.
        conditions: ["source", ...defaultClientConditions],
    },
    // Carreau resolves through its "source" condition; its .ts sources are
    // transformed, not externalized (see test.server below).
    ssr: { resolve: { conditions: ["source"] } },
    test: {
        include: ["tests/**/*.test.{ts,tsx}"],
        // The default configuration (config/default.yaml), for the interfaces.
        setupFiles: ["tests/setup.ts"],
        server: { deps: { inline: ["carreau"] } },
        // DOM globals (HTMLElement, customElements, …) available everywhere.
        // Individual files can still opt out with `// @vitest-environment node`.
        environment: "happy-dom",
        // Full runs spawn a real child process; give them room beyond the 5s default.
        testTimeout: 20_000,
        coverage: {
            provider: "v8",
            reporter: ["text", "lcov"],
            exclude: [
                "tests/**",
                "scripts/**",
                "**/incoming.ts",
                ...(configDefaults.coverage.exclude ?? []),
            ],
        },
    },
});
