import { describe, expect, test } from "vitest";
import { Buche, type OutM } from "../src/core.ts";
import type { OutgoingDriverMessage } from "../src/driver-exchange/outgoing.ts";
import { statusOf } from "../src/entry.ts";
import { resetId } from "../src/utils.ts";

interface Fixture {
    buche: Buche;
    driverOut: OutgoingDriverMessage[];
    interfaceOut: OutM[];
}

function machine(): Fixture {
    const fixture = {
        driverOut: [] as OutgoingDriverMessage[],
        interfaceOut: [] as OutM[],
    } as Fixture;
    fixture.buche = new Buche({
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
    test("a configured entry shows a placeholder, inline in its prompt's stream", () => {
        resetId(100);
        const f = machine();
        f.buche.handle({
            type: "prompt_configure",
            from: ["$proc", "cq"],
            to: ["$term"],
        } as never);
        f.interfaceOut.length = 0;
        f.buche.handle({ type: "configure", from: PROCESS, to: ["$term"], label: "ls" } as never);
        const entry = f.buche.get(PROCESS);
        const ph = f.buche.get([...PROCESS, "?"]);
        expect(f.interfaceOut).toEqual([
            {
                type: "update_cell",
                target: { zone: "inline", anchor: ["$proc", "cq"] },
                entry: ph,
            },
        ]);
        expect(f.driverOut).toEqual([]);
        expect(entry.primary).toBe(ph);
        expect(ph.placeholder).toBe(true);
        // It stands for the process, and shows what it was configured with.
        expect(ph.represents).toEqual(PROCESS);
        expect(ph.echo.label.text).toBe("ls");
        expect(statusOf(entry).status).toBe("running");
    });

    test("the first cell claims the placeholder: same entry, same place", () => {
        resetId(100);
        const f = booted();
        const cell = f.buche.get(CELL);
        expect(f.buche.hierarchy.getAt([...PROCESS, "?"])).toBe(null);
        expect(f.buche.get(PROCESS).primary).toBe(cell);
        expect(cell.placeholder).toBe(false);
        expect(cell.echo.address).toEqual(CELL);
        const updates = f.interfaceOut.filter((m: any) => m.type === "update_cell") as any[];
        // Installed once (as the placeholder), then only refreshed.
        expect(updates.map((m) => m.target)).toEqual([
            { zone: "inline", anchor: ["$proc", "cq"] },
            null,
        ]);
        expect(updates.every((m) => m.entry === cell)).toBe(true);
    });

    test("later cells go in a tab beside the first; zones are relative to the anchor", () => {
        resetId(100);
        const f = machine();
        f.buche.handle({
            type: "prompt_configure",
            from: ["$proc", "cq"],
            to: ["$term"],
        } as never);
        f.buche.handle({ type: "configure", from: PROCESS, to: ["$term"], zone: "@r" } as never);
        f.buche.handle({
            type: "data",
            from: [...PROCESS, "$gui"],
            to: ["$term"],
            data: 1,
        } as never);
        f.buche.handle({
            type: "text",
            from: [...PROCESS, "$stdout"],
            to: ["$term"],
            stream: "stdout",
            text: "x",
        } as never);
        f.buche.handle({
            type: "cell_configure",
            from: [...PROCESS, "plot"],
            to: ["$term"],
            zone: "@left",
        } as never);
        const targets = (f.interfaceOut.filter((m: any) => m.type === "update_cell") as any[]).map(
            (m) => m.target,
        );
        expect(targets).toEqual([
            { zone: "right", anchor: ["$proc", "cq"] },
            { zone: "tab", anchor: [...PROCESS, "$gui"] },
            { zone: "left", anchor: [...PROCESS, "$gui"] },
        ]);
        // `$` views stand for their process; other cells don't unless told.
        expect(f.buche.get([...PROCESS, "$stdout"]).represents).toEqual(PROCESS);
        expect(f.buche.get([...PROCESS, "plot"]).represents).toBe(null);
    });

    test("a prompt claims a placeholder in a tab, not an inline one", () => {
        resetId(100);
        const f = machine();
        f.buche.handle({
            type: "prompt_configure",
            from: ["$proc", "cq"],
            to: ["$term"],
        } as never);
        f.buche.handle({
            type: "configure",
            from: ["$proc", "cq", "1"],
            to: ["$term"],
            zone: "tab",
        } as never);
        f.buche.handle({ type: "configure", from: ["$proc", "cq", "2"], to: ["$term"] } as never);
        f.buche.handle({
            type: "prompt_configure",
            from: ["$proc", "cq", "1", "cq"],
            to: ["$term"],
        } as never);
        f.buche.handle({
            type: "prompt_configure",
            from: ["$proc", "cq", "2", "cq"],
            to: ["$term"],
        } as never);
        expect(f.buche.get(["$proc", "cq", "1", "cq"])).toBe(
            f.buche.get(["$proc", "cq", "1"]).primary,
        );
        expect(f.buche.get(["$proc", "cq", "1", "cq"]).cell).toBe(null);
        expect(f.buche.get(["$proc", "cq", "2", "?"]).placeholder).toBe(true);
        const last = f.interfaceOut.at(-1) as any;
        expect(last.target).toEqual({
            zone: "tab",
            anchor: ["$proc", "cq", "2", "?"],
            link: true,
        });
    });

    test("typing into a placeholder makes it the terminal", () => {
        resetId(100);
        const f = machine();
        f.buche.handle({ type: "configure", from: PROCESS, to: ["$term"] } as never);
        const ph = f.buche.get([...PROCESS, "?"]);
        f.buche.handle({ type: "user_text", text: "y", entry: ph } as never);
        expect(f.buche.get([...PROCESS, "$stdout"])).toBe(ph);
        expect((f.driverOut[0] as any).to).toEqual(PROCESS);
    });

    test("standby: set by a configure, and spent like running", () => {
        resetId(100);
        const f = booted();
        f.buche.handle({
            type: "configure",
            from: PROCESS,
            to: ["$term"],
            status: "standby",
        } as never);
        expect(statusOf(f.buche.get(CELL)).status).toBe("standby");
        f.buche.handle({
            type: "close",
            from: PROCESS,
            to: ["$term"],
            outcome: { type: "success" },
        } as never);
        expect(statusOf(f.buche.get(CELL)).status).toBe("done");
        f.buche.handle({
            type: "configure",
            from: PROCESS,
            to: ["$term"],
            status: "standby",
        } as never);
        expect(statusOf(f.buche.get(CELL)).status).toBe("done");
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
        // Nothing is installed: no cell is created if none existed. What
        // shows it is only brought up to date (its new label).
        expect(f.interfaceOut).toEqual([{ type: "update_entry", entry: cell }]);
        expect(f.driverOut).toEqual([]);
        // The entry itself is retuned instead.
        expect(cell.represents).toBe(null);
        expect(cell.echo.ephemeral).toBe(true);
        expect(cell.echo.label.text).toBe("retuned");
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
