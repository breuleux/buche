// @vitest-environment happy-dom

import { afterEach, describe, expect, test, vi } from "vitest";
import { Cell, type CellCommand } from "../src/cell.ts";
import { BucheGui, GUI_SEND_EVENT } from "../src/components/buche-gui.tsx";
import { EchoBox } from "../src/components/echo-box.tsx";
import type { PromptCollection } from "../src/components/prompt-collection.tsx";
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

// ── interface: size information sent to the gui page ─────────────────────────

describe("gui size information", () => {
    const infos = (gui: BucheGui): Record<string, unknown>[] =>
        ((gui as unknown as { queue: Record<string, unknown>[] }).queue ?? []).filter(
            (m) => m?.["buche-gui"] === "info",
        );

    test("a box resize refreshes the sizing information in the queue, in place", () => {
        const b = box();
        const cell = new Cell({});
        run(cell, b, { type: "html", content: "<p>hi</p>" });
        const gui = b.getView("gui")!.firstElementChild as BucheGui;

        b.dispatchEvent(new CustomEvent("resize", { bubbles: true }));
        expect(infos(gui)).toHaveLength(1);
        expect(infos(gui)[0]).toMatchObject({ "buche-gui": "info", dynamicHeight: true });
        expect(typeof infos(gui)[0]?.width).toBe("number");
        expect(typeof infos(gui)[0]?.maxHeight).toBe("number");

        // A stale info never waits in the queue behind the fresh one.
        b.dispatchEvent(new CustomEvent("resize", { bubbles: true }));
        expect(infos(gui)).toHaveLength(1);
    });

    test("a dragged (pinned) box announces dynamicHeight false", () => {
        const b = box();
        const cell = new Cell({});
        run(cell, b, { type: "data", data: {} });
        const gui = b.getView("gui")!.firstElementChild as BucheGui;
        (b.querySelector(".echo-box-cell") as HTMLElement).style.height = "300px";

        b.dispatchEvent(new CustomEvent("resize", { bubbles: true }));
        expect(infos(gui)[0]).toMatchObject({ dynamicHeight: false });
    });

    test("a pinned cell hands the height from the content to the fill, and back", () => {
        const b = box();
        const cell = new Cell({});
        run(cell, b, { type: "html", content: "<p>hi</p>" });
        const gui = b.getView("gui")!.firstElementChild as BucheGui;
        // Dynamic sizing drives the height from the content reports (inline).
        gui.style.height = "300px";

        // Pinning (as a gutter drag does): the inline height is dropped so the
        // stylesheet's fill height takes over.
        const cellEl = b.querySelector(".echo-box-cell") as HTMLElement;
        cellEl.style.height = "200px";
        b.setAttribute("pinned", "");
        b.dispatchEvent(new CustomEvent("resize", { bubbles: true }));
        expect(infos(gui)[0]).toMatchObject({ dynamicHeight: false });
        expect(gui.style.height).toBe("");

        // The double-click reset: content sizing takes the height back.
        cellEl.style.height = "";
        b.removeAttribute("pinned");
        b.dispatchEvent(new CustomEvent("resize", { bubbles: true }));
        expect(infos(gui)[0]).toMatchObject({ dynamicHeight: true });
    });

    test("a box filling a tab-pane pane announces dynamicHeight false", () => {
        const pane = document.createElement("div");
        pane.className = "tab-pane-pane";
        document.body.append(pane);
        const b = document.createElement("echo-box") as EchoBox;
        pane.append(b);
        const cell = new Cell({});
        run(cell, b, { type: "data", data: {} });
        const gui = b.getView("gui")!.firstElementChild as BucheGui;

        b.dispatchEvent(new CustomEvent("resize", { bubbles: true }));
        expect(infos(gui)[0]).toMatchObject({ dynamicHeight: false });
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

    test("switching to unified drops the terminal, forwarding its text to the gui", async () => {
        const { driver } = setup();
        driver({ type: "cell_configure", from: ["p"] });
        driver({ type: "text", from: ["p"], stream: "stdout", text: "hi there\n" });
        const box = document.querySelector<EchoBox>("echo-box")!;
        expect(box.querySelectorAll("embedded-term").length).toBe(1);

        const send = vi.spyOn(BucheGui.prototype, "send");
        driver({ type: "cell_configure", from: ["p"], mode: "unified" });
        // The forwarding waits for the terminal to parse what it was given.
        await new Promise((resolve) => setTimeout(resolve, 50));
        try {
            expect(box.querySelectorAll("embedded-term").length).toBe(0);
            expect(box.views).toEqual(["gui"]);
            expect(send.mock.calls.map((c) => c[0])).toContainEqual({
                type: "data",
                data: { $schema: "buche:text", text: "hi there\n", stream: "stdout" },
            });
        } finally {
            send.mockRestore();
        }
    });

    // A focusable outside the cell, to have somewhere for the focus to go
    // back to (happy-dom tab-pane visibility aside).
    function standIn(iface: BucheInterface): HTMLElement {
        const el = document.createElement("div");
        el.setAttribute("focusable", "");
        el.tabIndex = 0;
        iface.container.append(el);
        return el;
    }

    function stickyGuiCell(iface: BucheInterface, driver: (m: Record<string, unknown>) => void) {
        const other = standIn(iface);
        iface.focus.focus(other, "api");
        driver({ type: "cell_configure", from: ["p"], sticky: true });
        driver({ type: "cell_send", from: ["p"], message: { type: "data", data: {} } });
        const gui = document.querySelector<BucheGui>("buche-gui")!;
        return { other, gui, box: gui.closest("echo-box")! };
    }

    test("a sticky cell keeps the focus when it ends, even with the gui focused", () => {
        const { iface, driver } = setup();
        const { gui } = stickyGuiCell(iface, driver);
        expect(iface.focus.current).toBe(gui);

        driver({ type: "close", from: ["p"], outcome: { type: "success" } });
        expect(iface.focus.current).toBe(gui);
    });

    test("a cell sticky through its process keeps the focus when that process ends", () => {
        // The shape coquille produces for a main cell: the cell is a handle on
        // the process (`represents`), the process is configured on its own, and
        // `close` comes from it — so the ended entry is not the sticky echo.
        const { iface, driver } = setup();
        const other = standIn(iface);
        iface.focus.focus(other, "api");
        driver({ type: "configure", from: ["$proc", "1"] });
        driver({
            type: "cell_configure",
            from: ["$proc", "1", "$main"],
            represents: ["$proc", "1"],
            sticky: true,
        });
        driver({
            type: "cell_send",
            from: ["$proc", "1", "$main"],
            message: { type: "data", data: {} },
        });
        const gui = document.querySelector<BucheGui>("buche-gui")!;
        expect(iface.focus.current).toBe(gui);

        driver({ type: "close", from: ["$proc", "1"], outcome: { type: "success" } });
        expect(iface.focus.current).toBe(gui);
    });

    test("buche.leave() moves the focus away, even from a sticky cell", () => {
        const { iface, driver } = setup();
        const { other, gui, box } = stickyGuiCell(iface, driver);
        expect(iface.focus.current).toBe(gui);
        [...iface.interactions.purge()]; // clear the focus noise

        gui.dispatchEvent(
            new CustomEvent(GUI_SEND_EVENT, {
                detail: { type: "leave" },
                bubbles: true,
                composed: true,
            }),
        );
        expect(iface.focus.current).not.toBe(gui);
        expect(box.contains(iface.focus.current ?? box.parentNode)).toBe(false);
        expect(iface.focus.current).toBe(other);
        // A terminal-level command: not relayed to the process.
        expect([...iface.interactions.purge()]).toHaveLength(0);
    });

    test("buche.leave() leaves the cell when its box is in the history too", async () => {
        // The real sequence: the prompt, then the cell's box (which the command
        // was expected on), then the gui inside that box. Stepping back from
        // the gui onto the box would resolve right back onto the gui.
        const { iface, driver } = setup();
        driver({ type: "prompt_configure", from: ["$proc", "cq"], label: "cq" });
        await new Promise((resolve) => setTimeout(resolve, 0));
        const pc = document.querySelector<PromptCollection>("prompt-collection")!;
        const promptEl = pc.promptElement(pc.prompts[0])!;
        expect(iface.focus.current).toBe(promptEl);

        iface.focus.expect("echo-c1");
        driver({ type: "cell_configure", from: ["$proc", "cq", "2"], sticky: true, id: "c1" });
        await new Promise((resolve) => setTimeout(resolve, 0));
        const box = document.querySelector("#echo-c1")!;
        expect(iface.focus.current).toBe(box);

        driver({
            type: "cell_send",
            from: ["$proc", "cq", "2"],
            message: { type: "data", data: {} },
        });
        const gui = box.querySelector<BucheGui>("buche-gui")!;
        expect(iface.focus.current).toBe(gui);

        gui.dispatchEvent(
            new CustomEvent(GUI_SEND_EVENT, {
                detail: { type: "leave" },
                bubbles: true,
                composed: true,
            }),
        );
        expect(iface.focus.current).toBe(promptEl);
    });

    test("buche.leave() would rather go to the prompt than to another part of the cell", async () => {
        // The prompt, then something else in the same box (its terminal, say),
        // then the gui: stepping back would land on the terminal, i.e. nowhere
        // near the exit, so the prompt gets the focus instead.
        const { iface, driver } = setup();
        driver({ type: "prompt_configure", from: ["$proc", "cq"], label: "cq" });
        await new Promise((resolve) => setTimeout(resolve, 0));
        const pc = document.querySelector<PromptCollection>("prompt-collection")!;
        const promptEl = pc.promptElement(pc.prompts[0])!;

        driver({ type: "cell_configure", from: ["$proc", "cq", "2"], sticky: true });
        const box = document.querySelector("#echo-c2") ?? document.querySelector("echo-box")!;
        const inner = document.createElement("div");
        inner.setAttribute("focusable", "cell");
        inner.tabIndex = -1;
        box.append(inner);
        iface.focus.focus(promptEl, "api");
        iface.focus.focus(inner, "api");
        driver({
            type: "cell_send",
            from: ["$proc", "cq", "2"],
            message: { type: "data", data: {} },
        });
        const gui = box.querySelector<BucheGui>("buche-gui")!;
        expect(iface.focus.current).toBe(gui);

        gui.dispatchEvent(
            new CustomEvent(GUI_SEND_EVENT, {
                detail: { type: "leave" },
                bubbles: true,
                composed: true,
            }),
        );
        expect(iface.focus.current).toBe(promptEl);
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
