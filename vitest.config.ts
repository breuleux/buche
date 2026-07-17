import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

const fromRoot = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
    resolve: {
        alias: {
            "myjsx/jsx-runtime": fromRoot("./src/jsx/jsx-runtime.ts"),
            "myjsx/jsx-dev-runtime": fromRoot("./src/jsx/jsx-dev-runtime.ts"),
        },
    },
    test: {
        include: ["tests/**/*.test.{ts,tsx}"],
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
