import { describe, expect, test } from "vitest";
import { Buche, type OutM } from "../src/core.ts";
import type { OutgoingDriverMessage } from "../src/driver-exchange/outgoing.ts";
import { statusOf } from "../src/entry.ts";
import { resetId } from "../src/utils.ts";
import { Zone, type Zone as ZoneT, zoneMap } from "../src/zone.ts";

interface Fixture {
    buche: Buche;
    driverOut: OutgoingDriverMessage[];
    interfaceOut: OutM[];
}

function machine(zones: ZoneT[] = [new Zone({ names: ["@"] })]): Fixture {
    const fixture = {
        driverOut: [] as OutgoingDriverMessage[],
        interfaceOut: [] as OutM[],
    } as Fixture;
    fixture.buche = new Buche({
        initialZones: zoneMap(zones),
        sendDriver: (m) => fixture.driverOut.push(m),
        sendInterface: (m) => fixture.interfaceOut.push(m),
    });
    return fixture;
}

// A prompt, a configured process and its representing `$main` cell.
function booted(): Fixture {
    const f = machine();
    f.buche.handle({
        type: "prompt_configure",
        from: ["$proc", "cq"],
        to: ["$term"],
    } as never);
    f.buche.handle({ type: "configure", from: PROCESS, to: ["$term"] } as never);
    f.buche.handle({
        type: "cell_configure",
        from: CELL,
        to: ["$term"],
        represents: PROCESS,
    } as never);
    return f;
}

const PROCESS = ["$proc", "cq", "1"];
const CELL = ["$proc", "cq", "1", "$main"];

describe("represents", () => {
    test("a configured entry installs nothing and records its zones", () => {
        resetId(100);
        const f = machine();
        f.buche.handle({
            type: "prompt_configure",
            from: ["$proc", "cq"],
            to: ["$term"],
        } as never);
        f.interfaceOut.length = 0;
        f.buche.handle({ type: "configure", from: PROCESS, to: ["$term"] } as never);
        // No visual element whatsoever.
        expect(f.interfaceOut).toEqual([]);
        expect(f.driverOut).toEqual([]);
        const entry = f.buche.get(PROCESS);
        const promptZone = f.buche.get(["$proc", "cq"]).zones["@"];
        // Placement under "" and the zone's own names, origin under "origin".
        expect(entry.zones[""]).toBe(promptZone);
        expect(entry.zones.origin).toBe(promptZone);
        expect(entry.zones["@"]).toBe(promptZone);
        expect(statusOf(entry).status).toBe("running");
    });

    test('a nameless cell_configure resolves through the parent\'s ""', () => {
        resetId(100);
        const left = new Zone({ names: ["left"] });
        const f = machine([new Zone({ names: ["@"] }), left]);
        f.buche.handle({
            type: "configure",
            from: PROCESS,
            to: ["$term"],
            zone: "left",
        } as never);
        // Nothing on the way up defines "@": the cell must land in the
        // configured zone through the parent's "".
        f.buche.handle({ type: "cell_configure", from: CELL, to: ["$term"] } as never);
        const update = f.interfaceOut.find((m: any) => m.type === "update_cell") as any;
        expect(update.zone).toBe(left);
    });

    test("named lookups reach the configured zone through its spread names", () => {
        resetId(100);
        const f = machine();
        f.buche.handle({
            type: "prompt_configure",
            from: ["$proc", "cq"],
            to: ["$term"],
        } as never);
        const promptZone = f.buche.get(["$proc", "cq"]).zones["@"];
        f.buche.handle({ type: "configure", from: PROCESS, to: ["$term"] } as never);
        // The prompt zone is named "@": its spread answers "@" from the
        // process entry, ahead of anything further up.
        f.buche.handle({
            type: "cell_configure",
            from: CELL,
            to: ["$term"],
            zone: "@",
        } as never);
        const update = f.interfaceOut.find((m: any) => m.type === "update_cell") as any;
        expect(update.zone).toBe(promptZone);
    });

    test("signals, input and resize are routed to the represented address", () => {
        resetId(100);
        const f = booted();
        const cell = f.buche.get(CELL);
        f.driverOut.length = 0;

        f.buche.handle({ type: "user_signal", code: 15, entry: cell } as never);
        f.buche.handle({ type: "user_text", text: "ls\r", entry: cell } as never);
        f.buche.handle({
            type: "user_resize",
            pixel: { height: 10, width: 20 },
            entry: cell,
        } as never);

        expect(f.driverOut.map((m: any) => [m.type, m.to])).toEqual([
            ["signal", PROCESS],
            ["text", PROCESS],
            ["resize", PROCESS],
        ]);
    });

    test("the status mirrors the represented entry", () => {
        resetId(100);
        const f = booted();
        const cell = f.buche.get(CELL);
        expect(statusOf(cell).status).toBe("running");

        f.buche.handle({ type: "user_signal", code: 15, entry: cell } as never);
        expect(statusOf(cell).status).toBe("unresponsive");
        // The marking lands on the process, not on the cell itself.
        expect(f.buche.get(CELL).echo.status.status).not.toBe("unresponsive");

        f.buche.handle({
            type: "close",
            from: PROCESS,
            to: ["$term"],
            outcome: { type: "success", code: 0 },
        } as never);
        expect(statusOf(cell).status).toBe("done");
    });

    test("a prompt can stand for its process (sub-shell shape)", () => {
        resetId(100);
        const f = machine();
        f.buche.handle({ type: "configure", from: PROCESS, to: ["$term"], zone: null } as never);
        f.buche.handle({
            type: "prompt_configure",
            from: [...PROCESS, "cq"],
            to: ["$term"],
            represents: PROCESS,
        } as never);
        const prompt = f.buche.get([...PROCESS, "cq"]);
        expect(statusOf(prompt).status).toBe("running");

        // The prompt tab's ✕ signals the process, not the prompt.
        f.driverOut.length = 0;
        f.buche.handle({ type: "user_signal", code: 15, entry: prompt } as never);
        expect((f.driverOut[0] as any).to).toEqual(PROCESS);

        // When the process ends, the walk marks the prompt (its descendant)
        // too, and the mirror agrees.
        f.buche.handle({
            type: "close",
            from: PROCESS,
            to: ["$term"],
            outcome: { type: "success", code: 0 },
        } as never);
        expect(statusOf(prompt).status).toBe("done");
        expect(prompt.echo.status.status).toBe("done");
    });

    test("representing a never-configured entry falls back to the entry's own status", () => {
        resetId(100);
        const f = machine();
        // Top-level shape: coquille's prompt stands for ["$proc"], which
        // nothing ever configured — there is no process to mirror.
        f.buche.handle({
            type: "prompt_configure",
            from: ["$proc", "cq"],
            to: ["$term"],
            represents: ["$proc"],
        } as never);
        const prompt = f.buche.get(["$proc", "cq"]);
        expect(prompt.representative()).not.toBeNull();
        expect(prompt.representative()!.echo.status.status).toBe("absent");
        expect(statusOf(prompt).status).toBe("running");
    });

    test("configure retunes an existing entry without creating or installing", () => {
        resetId(100);
        const f = booted();
        const cell = f.buche.get(CELL);
        f.interfaceOut.length = 0;
        f.buche.handle({
            type: "configure",
            from: CELL,
            to: ["$term"],
            represents: null,
            ephemeral: true,
            label: "retuned",
        } as never);
        // Nothing is installed or announced: no cell is created if none
        // existed, and no interface message goes out.
        expect(f.interfaceOut).toEqual([]);
        expect(f.driverOut).toEqual([]);
        // The entry itself is retuned instead.
        expect(cell.represents).toBe(null);
        expect(cell.echo.ephemeral).toBe(true);
        expect(cell.echo.label).toBe("retuned");
        // A reconfigure of a started entry leaves the status alone.
        expect(statusOf(cell).status).toBe("running");
        // And interactions now use the entry's own address again.
        f.driverOut.length = 0;
        f.buche.handle({ type: "user_signal", code: 15, entry: cell } as never);
        expect((f.driverOut[0] as any).to).toEqual(CELL);
    });

    test("a configure never resurrects a spent entry", () => {
        resetId(100);
        const f = machine();
        f.buche.handle({ type: "configure", from: PROCESS, to: ["$term"] } as never);
        f.buche.handle({
            type: "close",
            from: PROCESS,
            to: ["$term"],
            outcome: { type: "success", code: 0 },
        } as never);
        f.buche.handle({ type: "configure", from: PROCESS, to: ["$term"] } as never);
        expect(f.buche.get(PROCESS).echo.status.status).toBe("done");
    });

    test("represents: null disables the mirroring", () => {
        resetId(100);
        const f = booted();
        f.buche.handle({
            type: "cell_configure",
            from: CELL,
            to: ["$term"],
            represents: null,
        } as never);
        const cell = f.buche.get(CELL);
        expect(statusOf(cell).status).toBe("running");
        f.driverOut.length = 0;
        f.buche.handle({ type: "user_signal", code: 15, entry: cell } as never);
        expect((f.driverOut[0] as any).to).toEqual(CELL);
    });
});
