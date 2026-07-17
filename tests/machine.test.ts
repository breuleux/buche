import { describe, test } from "node:test";
import { Machine } from "../src/machine.ts"
import { getCases, MachinePlayer } from "./utils.ts"


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
    const base = "data/sanity";
    const machine = new MachinePlayer(new SpellMachine(), base);

    for (const { name, relpath } of getCases(base)) {
        test(`Conformity of machine on '${relpath}'`, async () => {
            await machine.test(name);
        });
    }
});
