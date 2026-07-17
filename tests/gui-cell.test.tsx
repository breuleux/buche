// @vitest-environment happy-dom

import { afterEach, describe, expect, test } from "vitest";
import { Cell, type CellCommand } from "../src/cell.ts";
import { BucheGui } from "../src/components/buche-gui.tsx";
import { EchoBox } from "../src/components/echo-box.tsx";
import { TabbedZoneElement } from "../src/components/zone.tsx";
import { Buche, type InM, type OutM } from "../src/core.ts";
import type { OutgoingDriverMessage } from "../src/driver-exchange/outgoing.ts";
import { Entry } from "../src/entry.ts";
import { BucheInterface } from "../src/interface.tsx";
import { resetId } from "../src/utils.ts";
import { Zone, type Zone as ZoneT, zoneMap } from "../src/zone.ts";

afterEach(() => {
    document.body.replaceChildren();
});

// ── machine: cell_gui_feedback relay ──────────────────────────────────────────────

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

const CELL = ["$proc", "1", "$main"];

describe("cell_gui_feedback", () => {
    test("is relayed to the entry's address as a data request", () => {
        resetId(100);
        const f = machine();
        f.buche.handle({ type: "cell_configure", from: CELL, to: ["$term"] } as never);
        f.driverOut.length = 0;
        f.buche.handle({
            type: "cell_gui_feedback",
            entry: f.buche.get(CELL),
            data: { type: "resolve", request_id: "r1", path: "/x", params: {}, method: "GET" },
        } as never);
        expect(f.driverOut).toEqual([
            {
                type: "data",
                from: ["$term"],
                to: CELL,
                data: { type: "resolve", request_id: "r1", path: "/x", params: {}, method: "GET" },
            },
        ]);
    });
});

// ── interface: gui view creation ─────────────────────────────────────────────

function box(): EchoBox {
    const el = document.createElement("echo-box") as EchoBox;
    document.body.append(el);
    return el;
}

function run(cell: Cell, boxEl: EchoBox, ...commands: CellCommand[]): void {
    const entry = new Entry({});
    entry.setCell(cell);
    boxEl.bindEntry(entry);
    for (const command of commands) {
        cell.handle(command, entry, boxEl);
    }
}

describe("cell gui views", () => {
    test("a data command creates the gui view and makes it active", () => {
        const b = box();
        const cell = new Cell({});
        run(cell, b, { type: "data", data: { hello: "world" } });
        expect(b.views).toContain("gui");
        expect(b.activeView).toBe("gui");
        const gui = b.getView("gui")?.firstElementChild;
        expect(gui).toBeInstanceOf(BucheGui);
        expect(gui?.getAttribute("sandbox")).toBe("allow-scripts");
        expect(gui?.getAttribute("proc-cell-id")).toMatch(/^c\d+$/);
        // No terminal view was created.
        expect(b.views).not.toContain("pty");
    });

    test("html, exec, register and register_schemas share the one gui view", () => {
        const b = box();
        const cell = new Cell({});
        run(
            cell,
            b,
            { type: "html", content: "<p>hi</p>" },
            { type: "exec", code: "1+1" },
            { type: "register", handlers: { ping: "() => {}" } },
            { type: "register_schemas", schemas: { "x:y": "() => {}" } },
        );
        expect(b.views.filter((v) => v === "gui")).toHaveLength(1);
        expect(b.getView("gui")?.childElementCount).toBe(1);
    });

    test("split mode sends text to the terminal view", () => {
        const b = box();
        const cell = new Cell({ mode: "split" });
        run(cell, b, { type: "text", stream: "stdout", text: "hello\n" });
        expect(b.views).toContain("pty");
        expect(b.views).not.toContain("gui");
    });

    test("unified mode sends text to the gui as a data command", () => {
        const b = box();
        const cell = new Cell({ mode: "unified" });
        run(cell, b, { type: "text", stream: "stdout", text: "hello\n" });
        expect(b.views).toContain("gui");
        expect(b.views).not.toContain("pty");
    });

    test("a response does not bring the gui into existence", () => {
        const b = box();
        const cell = new Cell({});
        run(cell, b, { type: "response", response_id: "r1", value: 1 });
        expect(b.views).not.toContain("gui");
    });
});

// ── interface: nav-mode escape and kill from within the gui ──────────────────

describe("gui kill from the interface", () => {
    function setup() {
        const container = document.createElement("div");
        container.append(new TabbedZoneElement(["@", "main"]));
        document.body.append(container);
        const iface = new BucheInterface({
            container,
            template: container.firstElementChild as Element,
        });
        const sent: OutgoingDriverMessage[] = [];
        const buche: Buche = new Buche({
            initialZones: zoneMap(iface.zones),
            sendDriver: (m) => sent.push(m),
            sendInterface: (m) => iface.processMessage(buche, m),
        });
        const driver = (m: Record<string, unknown>) =>
            buche.handle({ to: ["$term"], ...m } as InM);
        return { iface, driver, sent };
    }

    test("every gui hands the capture-mode chord to the page", () => {
        const { iface, driver } = setup();
        driver({ type: "cell_configure", from: ["p"] });
        driver({ type: "cell_send", from: ["p"], message: { type: "data", data: {} } });
        const gui = document.querySelector<BucheGui>("buche-gui");
        expect(gui).not.toBeNull();
        // Ctrl+Q (the capture-mode entry) escapes the iframe into nav mode.
        expect(gui!.interceptChords()).toContain(iface.keys.enter);
        expect(gui!.interceptChords()).toContain("ctrl+q");
    });

    test("the focus moves to the gui when it appears", () => {
        const { iface, driver } = setup();
        driver({ type: "cell_configure", from: ["p"] });
        driver({ type: "cell_send", from: ["p"], message: { type: "data", data: {} } });
        const gui = document.querySelector<BucheGui>("buche-gui")!;
        expect(iface.focus.current).toBe(gui);
    });

    test("a background cell's gui does not take the focus", () => {
        const { iface, driver } = setup();
        driver({ type: "cell_configure", from: ["p"], background: true });
        driver({ type: "cell_send", from: ["p"], message: { type: "data", data: {} } });
        const gui = document.querySelector<BucheGui>("buche-gui")!;
        expect(iface.focus.current).not.toBe(gui);
    });

    test("text and gui are two views of the one box", () => {
        const { iface, driver } = setup();
        driver({ type: "cell_configure", from: ["p"] });
        driver({ type: "text", from: ["p"], stream: "stdout", text: "hi\n" });
        driver({ type: "cell_send", from: ["p"], message: { type: "data", data: {} } });
        // The gui took the focus, and the box now shows both views.
        const gui = document.querySelector<BucheGui>("buche-gui")!;
        const box = gui.closest("echo-box")!;
        expect(box.querySelectorAll("embedded-term").length).toBe(1);
        expect(box.querySelectorAll("buche-gui").length).toBe(1);
        expect(iface.focus.current).toBe(gui);
    });

    test("killCell targets the box when the focus is on the gui itself", () => {
        const { iface, driver } = setup();
        driver({ type: "cell_configure", from: ["p"] });
        driver({ type: "cell_send", from: ["p"], message: { type: "data", data: {} } });
        const gui = document.querySelector<BucheGui>("buche-gui")!;
        // What Ctrl+Q does to the focus: it lands on the <buche-gui> host.
        iface.focus.focus(gui, "nav");
        const target = iface.targetCell();
        expect(target).toBeInstanceOf(EchoBox);
        expect(target?.contains(gui)).toBe(true);
        iface.killCell();
        const queued = [...iface.interactions.purge()];
        expect(queued).toHaveLength(1);
        expect(queued[0]?.type).toBe("user_signal");
    });
});
