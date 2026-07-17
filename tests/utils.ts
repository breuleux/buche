import assert from "node:assert";
import { once } from "node:events";
import { readdirSync } from "node:fs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import { Machine } from "../src/machine.ts";

export async function* readJsonl<T = unknown>(filePath: string): AsyncGenerator<T, void, unknown> {
    const fileStream = fs.createReadStream(filePath, { encoding: "utf-8" });

    const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity, // Treats \r\n as a single line break
    });

    for await (const line of rl) {
        const trimmed = line.trim();
        if (trimmed) {
            yield JSON.parse(trimmed) as T;
        }
    }
}

export class MachinePlayer<In, Out> {
    machine: Machine<In, Out>;
    tmpdir: string;
    datadir: string;

    constructor(machine: Machine<In, Out>, datadir: string) {
        this.machine = machine;
        this.tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "buche-test-"));
        this.datadir = path.join(import.meta.dirname, datadir);
    }

    testFiles(testName: string) {
        return {
            input: path.join(this.datadir, `${testName}.source.jsonl`),
            expected: path.join(this.datadir, `${testName}.expected.jsonl`),
            obtained: path.join(this.tmpdir, `${testName}.obtained.jsonl`),
        };
    }

    async record(infile: string, outfile: string) {
        const inputStream = readJsonl<In>(infile);
        const outputStream = fs.createWriteStream(outfile, {
            encoding: "utf-8",
        });
        // Helper to write lines while properly handling stream backpressure
        const writeLine = async (data: Record<string, any>): Promise<void> => {
            const line = JSON.stringify(data) + "\n";
            if (!outputStream.write(line)) {
                await once(outputStream, "drain");
            }
        };
        try {
            for await (const inObj of inputStream) {
                // 1. Write the input object with $role: "in"
                await writeLine({ $role: "in", ...inObj });

                // 2. Feed to generator and write generated outputs with $role: "out"
                for await (const outObj of this.machine.process(inObj)) {
                    await writeLine({ $role: "out", ...outObj });
                }
            }
        } finally {
            outputStream.end();
            await once(outputStream, "finish");
        }
    }

    async test(name: string) {
        const { input, expected, obtained } = this.testFiles(name);
        const update = process.env.UPDATE_EXPECTED === "1";
        if (update || !fs.existsSync(expected)) {
            await this.record(input, expected);
        } else {
            await this.record(input, obtained);
            assert.strictEqual(
                fs.readFileSync(expected, "utf8"),
                fs.readFileSync(obtained, "utf8"),
                "The obtained output is different from the expected output",
            );
        }
    }
}

export function* getCases(directory: string) {
    const absdir = directory.startsWith("/")
        ? directory
        : path.join(import.meta.dirname, directory);
    for (const filename of readdirSync(absdir)) {
        const match = filename.match(/(.*)\.source\.jsonl$/);
        if (!match) continue;

        yield {
            filename,
            name: match[1],
            path: path.join(absdir, filename),
            relpath: path.join(directory, filename),
        };
    }
}
