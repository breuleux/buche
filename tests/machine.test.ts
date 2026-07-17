import { describe, test } from "node:test";
import { readdirSync } from "node:fs";
import { Machine } from "../src/machine.ts"
import { getCases, MachinePlayer } from "./utils.ts"
import path from "node:path";


interface InM {
    value: string;
}


interface OutM {
    value: number;
}


export class SpellMachine extends Machine<InM, OutM> {
    async* process(input: InM): AsyncIterable<OutM> {
        for (const ch of input.value) {
            yield {value: ch.charCodeAt(0)};
        }
    }
}


describe("Sanity check Machine", () => {
    const machine = new MachinePlayer(
        new SpellMachine(),
        path.join(import.meta.dirname, "data/sanity")
    );

    for (const name of getCases(machine.datadir)) {
        test(`Conformity of machine on '${name}.source.jsonl'`, async () => {
            await machine.test(name);
        });
    }
});
