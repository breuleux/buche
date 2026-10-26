// A process and its views: its placeholder, the cells under it, how they are
// placed, and how signals, input, resizes and statuses go between them.

import { describe, expect, test } from "vitest";
import { Buche, type OutM } from "../src/core.ts";
import type { OutgoingDriverMessage } from "../src/driver-exchange/outgoing.ts";
import { plainText, resetId } from "../src/utils.ts";

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

const SHELL = ["$proc", "cq"];
const PROCESS = ["$proc", "cq", "1"];
const STDOUT = [...PROCESS, "$stdout"];
const FRAME = [...PROCESS, "$frame"];

function handle(f: Fixture, m: Record<string, unknown>): void {
    f.buche.handle({ to: ["$term"], ...m } as never);
}

// A prompt and a configured process.
function started(): Fixture {
    const f = machine();
    handle(f, { type: "configure", kind: "prompt", from: SHELL });
    handle(f, { type: "configure", from: PROCESS, label: "app" });
    return f;
}

/** The addresses signals were sent to (and their codes). */
const signals = (f: Fixture) =>
    f.driverOut.filter((m) => m.type === "signal").map((m: any) => [m.to, m.code]);

describe("placement", () => {
    test("a configured entry shows a placeholder, inline in its prompt's stream", () => {
        resetId(100);
        const f = machine();
        handle(f, { type: "configure", kind: "prompt", from: SHELL });
        f.interfaceOut.length = 0;
        handle(f, { type: "configure", from: PROCESS, label: "ls" });
        const entry = f.buche.get(PROCESS);
        const ph = f.buche.get([...PROCESS, "?"]);
        expect(f.interfaceOut).toEqual([
            { type: "update_cell", target: { zone: "inline", anchor: SHELL }, entry: ph },
        ]);
        expect(f.driverOut).toEqual([]);
        expect(entry.primary).toBe(ph);
        expect(ph.cell.kind).toBe("pending");
        // It shows what its process was configured with, and runs.
        expect(plainText(ph.cell.label)).toBe("ls");
        expect(entry.cell.status.status).toBe("running");
        expect(ph.cell.status.status).toBe("running");
    });

    test("the first view claims the placeholder: same entry, same place", () => {
        resetId(100);
        const f = started();
        handle(f, { type: "configure", kind: "frame", from: FRAME });
        const view = f.buche.get(FRAME);
        expect(f.buche.hierarchy.getAt([...PROCESS, "?"])).toBe(null);
        expect(f.buche.get(PROCESS).primary).toBe(view);
        expect(view.cell.kind).toBe("frame");
        // It looks like its process.
        expect(plainText(view.cell.label)).toBe("app");
        const updates = f.interfaceOut.filter(
            (m: any) => m.type === "update_cell" && m.entry.cell.kind !== "prompt",
        ) as any[];
        // Installed once (as the placeholder), then only refreshed.
        expect(updates.map((m) => m.target)).toEqual([{ zone: "inline", anchor: SHELL }, null]);
        expect(updates.every((m) => m.entry === view)).toBe(true);
    });

    test("later cells go in a tab beside the first; zones are relative to the anchor", () => {
        resetId(100);
        const f = machine();
        handle(f, { type: "configure", kind: "prompt", from: SHELL });
        handle(f, { type: "configure", from: PROCESS, zone: "@r" });
        handle(f, { type: "configure", from: FRAME, kind: "frame" });
        handle(f, { type: "configure", from: STDOUT, kind: "terminal" });
        handle(f, { type: "configure", kind: "frame", from: [...PROCESS, "plot"], zone: "@left" });
        const targets = (
            f.interfaceOut.filter(
                (m: any) => m.type === "update_cell" && m.entry.cell.kind !== "prompt",
            ) as any[]
        ).map((m) => m.target);
        expect(targets).toEqual([
            { zone: "right", anchor: SHELL },
            null, // `$frame` takes the placeholder over: it stays where it is
            { zone: "tab", anchor: FRAME },
            { zone: "left", anchor: FRAME },
        ]);
    });

    test("a prompt claims a placeholder in a tab, not an inline one", () => {
        resetId(100);
        const f = machine();
        handle(f, { type: "configure", kind: "prompt", from: SHELL });
        handle(f, { type: "configure", from: ["$proc", "cq", "1"], zone: "tab" });
        handle(f, { type: "configure", from: ["$proc", "cq", "2"] });
        handle(f, { type: "configure", kind: "prompt", from: ["$proc", "cq", "1", "cq"] });
        handle(f, { type: "configure", kind: "prompt", from: ["$proc", "cq", "2", "cq"] });
        expect(f.buche.get(["$proc", "cq", "1", "cq"])).toBe(
            f.buche.get(["$proc", "cq", "1"]).primary,
        );
        expect(f.buche.get(["$proc", "cq", "1", "cq"]).cell.kind).toBe("prompt");
        expect(f.buche.get(["$proc", "cq", "2", "?"]).cell.kind).toBe("pending");
        const last = f.interfaceOut.at(-1) as any;
        expect(last.target).toEqual({
            zone: "tab",
            anchor: ["$proc", "cq", "2", "?"],
            link: true,
        });
    });

    test("a `$` is only a name: `$proc` under a driver's id gets its placeholder", () => {
        resetId(100);
        const f = machine();
        handle(f, { type: "configure", from: ["$d1", "$proc"], zone: "logs" });
        const ph = f.buche.get(["$d1", "$proc", "?"]);
        expect(ph.cell.kind).toBe("pending");
        expect(ph.target).toEqual({ zone: "logs", anchor: null });
    });
});

describe("configuration", () => {
    test("configure retunes an existing view without creating or installing", () => {
        resetId(100);
        const f = started();
        handle(f, { type: "configure", kind: "frame", from: FRAME });
        const view = f.buche.get(FRAME);
        f.interfaceOut.length = 0;
        handle(f, { type: "configure", from: FRAME, ephemeral: true, label: "retuned" });
        // Nothing is installed: what shows it is only brought up to date.
        expect(f.interfaceOut).toEqual([{ type: "update_entry", entry: view }]);
        expect(f.driverOut).toEqual([]);
        expect(view.cell.ephemeral).toBe(true);
        expect(plainText(view.cell.label)).toBe("retuned");
        expect(view.cell.status.status).toBe("running");
    });

    test("a process's look goes to its views, not to what is under a prompt", () => {
        resetId(100);
        const f = started();
        handle(f, { type: "configure", kind: "terminal", from: STDOUT });
        handle(f, { type: "configure", from: PROCESS, label: "renamed" });
        expect(plainText(f.buche.get(STDOUT).cell.label)).toBe("renamed");
        // The prompt's label is its own: its commands keep theirs.
        handle(f, { type: "configure", kind: "prompt", from: SHELL, label: "elsewhere" });
        expect(plainText(f.buche.get(PROCESS).cell.label)).toBe("renamed");
    });

    test("a configure never resurrects a spent entry", () => {
        resetId(100);
        const f = machine();
        handle(f, { type: "configure", from: PROCESS });
        handle(f, { type: "close", from: PROCESS, outcome: { type: "success", code: 0 } });
        handle(f, { type: "configure", from: PROCESS });
        expect(f.buche.get(PROCESS).cell.status.status).toBe("done");
    });
});

describe("statuses", () => {
    test("a process's close reaches its views", () => {
        resetId(100);
        const f = started();
        handle(f, { type: "configure", kind: "terminal", from: STDOUT });
        handle(f, { type: "configure", kind: "frame", from: FRAME });
        handle(f, { type: "close", from: PROCESS, outcome: { type: "error", code: 2 } });
        expect(f.buche.get(STDOUT).cell.status).toEqual({ status: "error", code: 2 });
        expect(f.buche.get(FRAME).cell.status).toEqual({ status: "error", code: 2 });
    });

    test("standby: set on a process, it reaches its views; spent ones stay spent", () => {
        resetId(100);
        const f = started();
        handle(f, { type: "configure", kind: "terminal", from: STDOUT });
        handle(f, { type: "configure", from: PROCESS, status: "standby" });
        expect(f.buche.get(PROCESS).cell.status.status).toBe("standby");
        expect(f.buche.get(STDOUT).cell.status.status).toBe("standby");
        handle(f, { type: "configure", from: PROCESS, status: "running" });
        expect(f.buche.get(STDOUT).cell.status.status).toBe("running");
        handle(f, { type: "close", from: PROCESS, outcome: { type: "success" } });
        handle(f, { type: "configure", from: PROCESS, status: "standby" });
        expect(f.buche.get(STDOUT).cell.status.status).toBe("done");
    });

    test("a reset starts an ended process over: it and its views run again", () => {
        resetId(100);
        const f = started();
        handle(f, { type: "configure", kind: "terminal", from: STDOUT });
        handle(f, { type: "close", from: PROCESS, outcome: { type: "error", code: 2 } });
        f.interfaceOut.length = 0;
        handle(f, { type: "reset", from: PROCESS });
        expect(f.buche.get(PROCESS).cell.status).toEqual({ status: "running" });
        expect(f.buche.get(STDOUT).cell.status).toEqual({ status: "running" });
        expect(f.interfaceOut).toContainEqual({
            type: "update_entry",
            entry: f.buche.get(STDOUT),
        });
        handle(f, { type: "close", from: PROCESS, outcome: { type: "success", code: 0 } });
        expect(f.buche.get(STDOUT).cell.status).toEqual({ status: "done", code: 0 });
    });

    test("a reset leaves a live process's status, and prompts, alone", () => {
        resetId(100);
        const f = started();
        handle(f, { type: "configure", kind: "terminal", from: STDOUT });
        handle(f, { type: "configure", from: PROCESS, status: "standby" });
        handle(f, { type: "reset", from: PROCESS });
        expect(f.buche.get(STDOUT).cell.status.status).toBe("standby");
        handle(f, { type: "close", from: SHELL, outcome: { type: "success" } });
        handle(f, { type: "reset", from: SHELL });
        expect(f.buche.get(SHELL).cell.status.status).toBe("done");
        expect(f.buche.get(STDOUT).cell.status.status).toBe("running");
    });
});

describe("rerun", () => {
    test("rerunning a cell asks its driver, at the cell's address, and changes nothing yet", () => {
        resetId(100);
        const f = started();
        handle(f, { type: "configure", kind: "terminal", from: STDOUT });
        handle(f, { type: "close", from: PROCESS, outcome: { type: "success" } });
        f.interfaceOut.length = 0;
        f.buche.handle({ type: "user_rerun", entry: f.buche.get(STDOUT) } as never);
        expect(f.driverOut).toEqual([{ type: "rerun", from: ["$term"], to: STDOUT }]);
        expect(f.interfaceOut).toEqual([]);
        expect(f.buche.get(STDOUT).cell.status.status).toBe("done");
    });
});

describe("signals, input and resizes", () => {
    test("closing a process's only view signals it, and the process", () => {
        resetId(100);
        const f = started();
        handle(f, { type: "configure", kind: "terminal", from: STDOUT });
        f.buche.handle({ type: "user_signal", code: 15, entry: f.buche.get(STDOUT) } as never);
        expect(signals(f)).toEqual([
            [STDOUT, 15],
            [PROCESS, 15],
        ]);
        expect(f.buche.get(STDOUT).cell.status.status).toBe("unresponsive");
        expect(f.buche.get(PROCESS).cell.status.status).toBe("unresponsive");
    });

    test("the placeholder's ✕ signals its process", () => {
        resetId(100);
        const f = started();
        f.buche.handle({
            type: "user_signal",
            code: 15,
            entry: f.buche.get([...PROCESS, "?"]),
        } as never);
        expect(signals(f)).toEqual([
            [[...PROCESS, "?"], 15],
            [PROCESS, 15],
        ]);
    });

    test("with two views, the process is signalled with the last", () => {
        resetId(100);
        const f = started();
        handle(f, { type: "configure", kind: "terminal", from: STDOUT });
        handle(f, { type: "configure", kind: "frame", from: FRAME });
        f.buche.handle({ type: "user_signal", code: 15, entry: f.buche.get(FRAME) } as never);
        expect(signals(f)).toEqual([[FRAME, 15]]);
        f.buche.handle({ type: "user_signal", code: 9, entry: f.buche.get(STDOUT) } as never);
        expect(signals(f)).toEqual([
            [FRAME, 15],
            [STDOUT, 9],
            [PROCESS, 9],
        ]);
    });

    test("a spent view counts as signalled", () => {
        resetId(100);
        const f = started();
        handle(f, { type: "configure", kind: "terminal", from: STDOUT });
        handle(f, { type: "configure", kind: "frame", from: FRAME });
        handle(f, { type: "close", from: FRAME, outcome: { type: "success" } });
        f.buche.handle({ type: "user_signal", code: 15, entry: f.buche.get(STDOUT) } as never);
        expect(signals(f)).toEqual([
            [STDOUT, 15],
            [PROCESS, 15],
        ]);
    });

    test("a prompt's ✕ signals its shell; what is under a prompt stops there", () => {
        resetId(100);
        const f = machine();
        // A sub-shell's shape: its prompt claims the process's (tab) placeholder.
        handle(f, { type: "configure", kind: "prompt", from: SHELL });
        handle(f, { type: "configure", from: PROCESS, zone: "tab" });
        const sub = [...PROCESS, "cq"];
        handle(f, { type: "configure", kind: "prompt", from: sub });
        handle(f, { type: "configure", kind: "frame", from: [...sub, "1"] });
        // A cell under the prompt: no process of its own to end.
        f.buche.handle({
            type: "user_signal",
            code: 15,
            entry: f.buche.get([...sub, "1"]),
        } as never);
        expect(signals(f)).toEqual([[[...sub, "1"], 15]]);
        // The prompt: the sub-shell is signalled.
        f.buche.handle({ type: "user_signal", code: 15, entry: f.buche.get(sub) } as never);
        expect(signals(f).slice(1)).toEqual([
            [sub, 15],
            [PROCESS, 15],
        ]);
    });

    test("input and resizes go to the cell's own address", () => {
        resetId(100);
        const f = started();
        handle(f, { type: "configure", kind: "terminal", from: STDOUT });
        const entry = f.buche.get(STDOUT);
        f.buche.handle({ type: "user_text", text: "x", entry } as never);
        f.buche.handle({
            type: "user_resize",
            pixel: { height: 10, width: 20 },
            pty: { height: 1, width: 2 },
            entry,
        } as never);
        expect(f.driverOut.map((m: any) => [m.type, m.to])).toEqual([
            ["text", STDOUT],
            ["resize", STDOUT],
        ]);
    });

    test("typing into a placeholder makes it the process's terminal", () => {
        resetId(100);
        const f = started();
        const ph = f.buche.get([...PROCESS, "?"]);
        f.buche.handle({ type: "user_text", text: "y", entry: ph } as never);
        expect(f.buche.get(STDOUT)).toBe(ph);
        expect(ph.cell.kind).toBe("terminal");
        expect((f.driverOut[0] as any).to).toEqual(STDOUT);
    });
});
