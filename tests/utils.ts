import fs, { readdirSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";

import { Buche, type InM } from "../src/core.ts";
import type { OutgoingDriverMessage } from "../src/driver-exchange/outgoing.ts";
import type { OutgoingInterfaceMessage } from "../src/interface-exchange/outgoing.ts";
import { AsyncQueue } from "../src/utils.ts";
import { Zone, zoneMap } from "../src/zone.ts";

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

export class MachinePlayer {
    machine: Buche;
    datadir: string;
    driverQueue: AsyncQueue<OutgoingDriverMessage> = new AsyncQueue();
    interfaceQueue: AsyncQueue<OutgoingInterfaceMessage> = new AsyncQueue();

    constructor(datadir: string) {
        this.machine = new Buche({
            initialZones: zoneMap([new Zone("@")]),
            sendDriver: this.driverQueue.push.bind(this.driverQueue),
            sendInterface: this.interfaceQueue.push.bind(this.interfaceQueue),
        });
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

        for await (const inObj of readJsonl<InM>(infile)) {
            write({ $role: "driverIn", ...inObj });
            this.machine.handle(inObj);
            for await (const outObj of this.driverQueue.purge()) {
                write({ $role: "driverOut", ...outObj });
            }
            for await (const outObj of this.interfaceQueue.purge()) {
                write({ $role: "interfaceOut", ...outObj });
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
