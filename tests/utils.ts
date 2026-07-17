import fs, { readdirSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";

import type { Machine } from "../src/machine.ts";
import { outgoingDriverMessageTypes } from "../src/message-directory.ts";

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
    datadir: string;

    constructor(machine: Machine<In, Out>, datadir: string) {
        this.machine = machine;
        this.datadir = path.join(import.meta.dirname, datadir);
    }

    testFiles(testName: string) {
        return {
            input: path.join(this.datadir, `${testName}.source.jsonl`),
            expected: path.join(this.datadir, `${testName}.expected.jsonl`),
        };
    }

    /**
     * Play `infile` through the machine and return the recorded run as a JSONL
     * string: each input line tagged `$role: "driverIn"`, followed by the
     * machine's outputs tagged `driverOut` (driver-outgoing types) or
     * `interfaceOut` (interface messages / errors). Fed to `toMatchFileSnapshot`.
     */
    async render(infile: string): Promise<string> {
        const lines: string[] = [];
        const write = (data: Record<string, any>) => lines.push(JSON.stringify(data));

        for await (const inObj of readJsonl<In>(infile)) {
            write({ $role: "driverIn", ...inObj });
            for await (const outObj of this.machine.process(inObj)) {
                const role = outgoingDriverMessageTypes.has((outObj as any).type)
                    ? "driverOut"
                    : "interfaceOut";
                write({ $role: role, ...outObj });
            }
        }
        // Trailing newline so the snapshot matches the recorded `.jsonl` files.
        return `${lines.join("\n")}\n`;
    }
}

export function* getCases(directory: string) {
    const absdir = directory.startsWith("/")
        ? directory
        : path.join(import.meta.dirname, directory);
    for (const filename of readdirSync(absdir)) {
        const match = filename.match(/(.*)\.source\.jsonl$/);
        if (!match) {
            continue;
        }

        yield {
            filename,
            name: match[1],
            path: path.join(absdir, filename),
            relpath: path.join(directory, filename),
        };
    }
}
