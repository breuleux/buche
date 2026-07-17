import { describe, expect, test } from "vitest";
import { resetId } from "../src/utils.ts";
import { getCases, MachinePlayer } from "./utils.ts";

for (const base of ["data/runs", "data/errors"]) {
    describe(`Check playbooks in ${base}`, () => {
        for (const { name, relpath } of getCases(base)) {
            test(`Conformity of machine on '${relpath}'`, async () => {
                // Fresh Buche per playbook so scenarios stay independent.
                resetId(100);
                const machine = new MachinePlayer(base);
                const { input, expected } = machine.testFiles(name);
                await expect(await machine.render(input)).toMatchFileSnapshot(expected);
            });
        }
    });
}
