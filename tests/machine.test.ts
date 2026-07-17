import { describe, expect, test } from "vitest";
import { Buche, type HandlerT } from "../src/core.ts";
import { handlers as driverHandlers } from "../src/driver-exchange/incoming.ts";
import { handlers as interfaceHandlers } from "../src/interface-exchange/incoming.ts";
import { Machine } from "../src/machine.ts";
import { resetId } from "../src/utils.ts";
import { Zone, zoneMap } from "../src/zone.ts";
import { getCases, MachinePlayer } from "./utils.ts";

interface InM {
    value: string;
}

interface OutM {
    value: number;
}

export class SpellMachine extends Machine<InM, OutM> {
    async *process(input: InM): AsyncIterable<OutM> {
        for (const ch of input.value) {
            yield { value: ch.charCodeAt(0) };
        }
    }
}

describe("Sanity check Machine", () => {
    const base = "data/sanity";
    const machine = new MachinePlayer(new SpellMachine(), base);

    for (const { name, relpath } of getCases(base)) {
        test(`Conformity of machine on '${relpath}'`, async () => {
            const { input, expected } = machine.testFiles(name);
            await expect(await machine.render(input)).toMatchFileSnapshot(expected);
        });
    }
});

for (const base of ["data/runs", "data/errors"]) {
    describe(`Check playbooks in ${base}`, () => {
        for (const { name, relpath } of getCases(base)) {
            test(`Conformity of machine on '${relpath}'`, async () => {
                // Fresh Buche per playbook so scenarios stay independent.
                resetId(100);
                const buche = new Buche({
                    handlers: Object.assign({}, driverHandlers, interfaceHandlers) as HandlerT,
                    initialZones: zoneMap([new Zone("@")]),
                });
                const machine = new MachinePlayer(buche, base);
                const { input, expected } = machine.testFiles(name);
                await expect(await machine.render(input)).toMatchFileSnapshot(expected);
            });
        }
    });
}
