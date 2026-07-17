import assert from "node:assert";
import { cpSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { ProcessCommunicator } from "../src/process.ts";
import { resetId } from "../src/utils.ts";
import { readJsonlWithBoot, simulate, writeJsonl } from "./sim.ts";
import { getCases } from "./utils.ts";

// Full end-to-end runs, driven through `simulate` (the core of `scripts/sim.ts`).
// For each `data/full/XYZ.source.jsonl` (a boot line plus any interface
// messages), the recorded run is checked against `data/full/XYZ.expected.jsonl`.
// Regenerate the expected files with `npm run test:update`.
//
// Every playbook runs against a fresh copy of `tests/fakehome`, so the command
// has a stable, throwaway working directory.

const base = "data/full";
const fakehome = path.join(import.meta.dirname, "fakehome");

describe("Full runs", () => {
    for (const { name, path: sourcePath } of getCases(base)) {
        test(`Full run '${name}'`, async () => {
            const expectedPath = sourcePath.replace(/\.source\.jsonl$/, ".expected.jsonl");

            const { boot, items: messages } = readJsonlWithBoot(sourcePath);
            const command = boot?.command;
            assert.ok(command, `${name}.source.jsonl must start with a boot line with a command`);
            const pause = boot?.pause ?? 0;

            // Copy fakehome so the command runs against a throwaway directory and
            // never mutates the checked-in fixture.
            const cwd = mkdtempSync(path.join(tmpdir(), "buche-full-"));
            cpSync(fakehome, cwd, { recursive: true });

            const process = new ProcessCommunicator(command, { cwd });

            // Deterministic ids, so a replay lines up with its recording.
            resetId(0);

            const update = globalThis.process.env.UPDATE_EXPECTED === "1";
            if (update || !existsSync(expectedPath)) {
                // Record: run the playbook and write the tagged sequence, with a
                // leading boot line so the file is also replayable via the CLI.
                const collected: any[] = [];
                for await (const message of simulate({ process, messages, pause })) {
                    collected.push(message);
                }
                writeJsonl(expectedPath, [{ type: "boot", command, pause }, ...collected]);
            } else {
                // Replay: `simulate` compares against the recorded sequence and
                // throws on any divergence, failing the test.
                const { items: replay } = readJsonlWithBoot(expectedPath);
                for await (const _ of simulate({ process, messages, replay, pause })) {
                    // Comparison happens inside `simulate`.
                }
            }
        });
    }
});
