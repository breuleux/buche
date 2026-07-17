// The merged prompt_configure: keystroke echoes (request_id-anchored) and
// authoritative reconfigurations of a live prompt.

import { describe, expect, test } from "vitest";
import { Buche, type OutM } from "../src/core.ts";
import type { OutgoingDriverMessage } from "../src/driver-exchange/outgoing.ts";
import type { Entry } from "../src/entry.ts";
import { resetId } from "../src/utils.ts";
import { Zone, type Zone as ZoneT, zoneMap } from "../src/zone.ts";

const PROMPT = ["$proc", "cq"];

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
    fixture.buche.handle({ type: "prompt_configure", from: PROMPT, to: ["$term"] } as never);
    return fixture;
}

function prompt(f: Fixture): Entry {
    return f.buche.get(PROMPT);
}

function type(f: Fixture, text: string): void {
    f.buche.handle({ type: "user_input", entry: prompt(f), text, position: text.length } as never);
}

function echo(
    f: Fixture,
    requestId: string,
    text: string,
    extra: Record<string, unknown> = {},
): void {
    f.buche.handle({
        type: "prompt_configure",
        from: PROMPT,
        to: ["$term"],
        request_id: requestId,
        submission: { content: { text, ranges: [] } },
        filigrane: `${text} -l`,
        ...extra,
    } as never);
}

describe("prompt_configure echo", () => {
    test("user_input stamps parse and prompt with a request_id", () => {
        resetId(100);
        const f = machine();
        type(f, "ls");
        const parse = f.driverOut.at(-1)!;
        expect(parse).toMatchObject({ type: "parse", text: "ls", request_id: "r1" });
        expect(prompt(f).prompt!.request_id).toBe("r1");
    });

    test("the matching echo applies content and filigrane, not status", () => {
        resetId(100);
        const f = machine();
        type(f, "ls");
        prompt(f).echo.status = { status: "unresponsive" }; // whatever mirrors it
        f.interfaceOut.length = 0;
        echo(f, "r1", "ls");
        const p = prompt(f).prompt!;
        expect(p.submission.content.text).toBe("ls");
        expect(p.filigrane).toBe("ls -l");
        expect(prompt(f).echo.status.status).toBe("unresponsive"); // untouched
        expect(f.interfaceOut).toEqual([
            { type: "update_prompt", zone: p.zones.main, entry: prompt(f) },
        ]);
    });

    test("an echo for a superseded parse is dropped", () => {
        resetId(100);
        const f = machine();
        type(f, "ls");
        echo(f, "r1", "ls");
        type(f, "ls -a"); // typed on before r1's answer (r2) — here, r1 late
        f.interfaceOut.length = 0;
        echo(f, "r1", "ls", { filigrane: "stale" }); // stale: dropped
        expect(prompt(f).prompt!.filigrane).toBe("ls -l");
        expect(f.interfaceOut).toEqual([]);
        echo(f, "r2", "ls -a"); // the fresh one applies
        expect(prompt(f).prompt!.filigrane).toBe("ls -a -l");
    });

    test("an authoritative configure takes over and voids the outstanding echo", () => {
        resetId(100);
        const f = machine();
        type(f, "ls");
        f.buche.handle({
            type: "prompt_configure", // the submit reset
            from: PROMPT,
            to: ["$term"],
            submission: { content: { text: "", ranges: [], position: 0 } },
            filigrane: null,
        } as never);
        const p = prompt(f).prompt!;
        expect(p.submission.content.text).toBe("");
        expect(p.filigrane).toBeNull();
        f.interfaceOut.length = 0;
        echo(f, "r1", "ls"); // the pre-submit echo: now void
        expect(p.filigrane).toBeNull();
        expect(f.interfaceOut).toEqual([]);
    });

    test("reconfiguring a live prompt leaves its zones and status alone", () => {
        resetId(100);
        const f = machine();
        const entry = prompt(f);
        const zones = Object.keys(entry.zones).sort();
        entry.echo.status = { status: "done" };
        f.buche.handle({
            type: "prompt_configure",
            from: PROMPT,
            to: ["$term"],
            label: "new",
        } as never);
        expect(Object.keys(entry.zones).sort()).toEqual(zones);
        expect(entry.echo.status.status).toBe("done"); // not re-stamped running
        expect(entry.echo.label).toBe("new"); // the configuration did apply
    });
});
