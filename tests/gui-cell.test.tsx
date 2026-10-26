// @vitest-environment happy-dom

import { afterEach, describe, expect, test } from "vitest";
import type { Cell, CellCommand } from "../src/cell.ts";
import { FrameCell, PendingCell, TerminalCell } from "../src/cells/index.ts";
import { BucheGui, GUI_SEND_EVENT } from "../src/components/buche-gui.tsx";
import { EchoBox } from "../src/components/echo-box.tsx";
import type { PromptCollection } from "../src/components/prompt-collection.tsx";
import { Buche, type InM, type OutM } from "../src/core.ts";
import type { OutgoingDriverMessage } from "../src/driver-exchange/outgoing.ts";
import { Entry } from "../src/entry.ts";
import { BucheInterface } from "../src/interface.tsx";
import { resetId } from "../src/utils.ts";

afterEach(() => {
    document.body.replaceChildren();
});

// ── machine: cell_gui_feedback relay ──────────────────────────────────────────────

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

const CELL = ["$proc", "1", "$main"];

describe("cell_gui_feedback", () => {
    test("is relayed to the entry's address as a data request", () => {
        resetId(100);
        const f = machine();
        f.buche.handle({ type: "configure", kind: "frame", from: CELL, to: ["$term"] } as never);
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
    entry.cell = cell;
    boxEl.bindEntry(entry);
    for (const command of commands) {
        cell.handle(command, entry, boxEl);
    }
}

describe("cell content", () => {
    test("a data command creates the gui", () => {
        const b = box();
        const cell = new FrameCell();
        run(cell, b, { type: "data", data: { hello: "world" } });
        const gui = b.content;
        expect(gui).toBeInstanceOf(BucheGui);
        expect(gui?.getAttribute("sandbox")).toBe("allow-scripts");
        expect(gui?.getAttribute("proc-cell-id")).toMatch(/^c\d+$/);
        expect(b.querySelector("embedded-term")).toBeNull();
    });

    test("html, exec, register and register_schemas share the one gui", () => {
        const b = box();
        const cell = new FrameCell();
        run(
            cell,
            b,
            { type: "html", content: "<p>hi</p>" },
            { type: "exec", code: "1+1" },
            { type: "register", handlers: { ping: "() => {}" } },
            { type: "register_schemas", schemas: { "x:y": "() => {}" } },
        );
        expect(b.querySelectorAll("buche-gui")).toHaveLength(1);
    });

    test("text goes to the terminal", () => {
        const b = box();
        const cell = new TerminalCell();
        run(cell, b, { type: "text", stream: "stdout", text: "hello\n" });
        expect(b.content?.localName).toBe("embedded-term");
        expect(b.querySelector("buche-gui")).toBeNull();
    });

    test("a placeholder's terminal goes when it becomes a frame", () => {
        const b = box();
        const entry = new Entry({});
        entry.cell = new PendingCell();
        b.bindEntry(entry);
        entry.cell.initialize(entry, b);
        expect(b.content?.localName).toBe("embedded-term");
        const frame = entry.replaceCell("frame");
        frame.handle({ type: "data", data: {} }, entry, b);
        expect(b.content).toBeInstanceOf(BucheGui);
        expect(b.querySelector("embedded-term")).toBeNull();
    });

    test("a response does not bring the gui into existence", () => {
        const b = box();
        const cell = new FrameCell();
        run(cell, b, { type: "response", response_id: "r1", value: 1 });
        expect(b.content).toBeNull();
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
        const cell = new FrameCell();
        run(cell, b, { type: "html", content: "<p>hi</p>" });
        const gui = b.content as BucheGui;

        b.dispatchEvent(new CustomEvent("resize", { bubbles: true }));
        expect(infos(gui)).toHaveLength(1);
        expect(infos(gui)[0]).toMatchObject({ "buche-gui": "info", dynamicHeight: true });
        expect(typeof infos(gui)[0]?.width).toBe("number");
        expect(typeof infos(gui)[0]?.maxHeight).toBe("number");

        // A stale info never waits in the queue behind the fresh one.
        b.dispatchEvent(new CustomEvent("resize", { bubbles: true }));
        expect(infos(gui)).toHaveLength(1);
    });

    test("a box filling its pane takes the height from the content, and gives it back", () => {
        const b = box();
        const cell = new FrameCell();
        run(cell, b, { type: "html", content: "<p>hi</p>" });
        const gui = b.content as BucheGui;
        // Dynamic sizing drives the height from the content reports (inline).
        gui.style.height = "300px";

        // Filling its pane: the inline height is dropped so the stylesheet's
        // fill height takes over.
        b.setAttribute("fills", "");
        b.dispatchEvent(new CustomEvent("resize", { bubbles: true }));
        expect(infos(gui)[0]).toMatchObject({ dynamicHeight: false });
        expect(gui.style.height).toBe("");

        // Back in a stream: content sizing takes the height back.
        b.removeAttribute("fills");
        b.dispatchEvent(new CustomEvent("resize", { bubbles: true }));
        expect(infos(gui)[0]).toMatchObject({ dynamicHeight: true });
    });

    test("a box filling its pane announces dynamicHeight false", () => {
        const b = document.createElement("echo-box") as EchoBox;
        b.setAttribute("fills", "");
        document.body.append(b);
        const cell = new FrameCell();
        run(cell, b, { type: "data", data: {} });
        const gui = b.content as BucheGui;

        b.dispatchEvent(new CustomEvent("resize", { bubbles: true }));
        expect(infos(gui)[0]).toMatchObject({ dynamicHeight: false });
    });
});

// ── interface: nav-mode escape and kill from within the gui ──────────────────

describe("gui kill from the interface", () => {
    function setup() {
        const container = document.createElement("div");
        document.body.append(container);
        const iface = new BucheInterface({ container });
        const sent: OutgoingDriverMessage[] = [];
        const buche: Buche = new Buche({
            sendDriver: (m) => sent.push(m),
            sendInterface: (m) => iface.processMessage(buche, m),
        });
        const driver = (m: Record<string, unknown>) =>
            buche.handle({ to: ["$term"], ...m } as InM);
        return { iface, driver, sent };
    }

    test("every gui hands the navigation-mode chord to the page", () => {
        const { driver } = setup();
        driver({ type: "configure", kind: "frame", from: ["p"] });
        driver({ type: "send", from: ["p"], message: { type: "data", data: {} } });
        const gui = document.querySelector<BucheGui>("buche-gui");
        expect(gui).not.toBeNull();
        // Alt+Q (the layout's navigation mode) escapes the iframe.
        expect(gui!.interceptChords()).toContain("Alt+q");
    });

    test("the focus moves to the gui when it appears", () => {
        const { iface, driver } = setup();
        driver({ type: "configure", kind: "frame", from: ["p"] });
        driver({ type: "send", from: ["p"], message: { type: "data", data: {} } });
        const gui = document.querySelector<BucheGui>("buche-gui")!;
        expect(iface.focus.current).toBe(gui);
    });

    test("a background cell's gui does not take the focus", () => {
        const { iface, driver } = setup();
        driver({ type: "configure", kind: "frame", from: ["p"], background: true });
        driver({ type: "send", from: ["p"], message: { type: "data", data: {} } });
        const gui = document.querySelector<BucheGui>("buche-gui")!;
        expect(iface.focus.current).not.toBe(gui);
    });

    test("text for a frame cell is refused", () => {
        const { driver } = setup();
        driver({ type: "configure", from: ["p"], kind: "frame" });
        driver({
            type: "send",
            from: ["p"],
            message: { type: "text", stream: "stdout", text: "hi\n" },
        });
        const box = document.querySelector<EchoBox>("echo-box")!;
        expect(box.content).toBeInstanceOf(BucheGui);
        expect(box.querySelector("embedded-term")).toBeNull();
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
        driver({ type: "configure", kind: "frame", from: ["p"], sticky: true });
        driver({ type: "send", from: ["p"], message: { type: "data", data: {} } });
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
            type: "configure",
            kind: "frame",
            from: ["$proc", "1", "$main"],
            represents: ["$proc", "1"],
            sticky: true,
        });
        driver({
            type: "send",
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
        driver({ type: "configure", kind: "prompt", from: ["$proc", "cq"], label: "cq" });
        await new Promise((resolve) => setTimeout(resolve, 0));
        const pc = document.querySelector<PromptCollection>("prompt-collection")!;
        const promptEl = pc.promptElement(pc.prompts[0])!;
        expect(iface.focus.current).toBe(promptEl);

        // The process's placeholder, taken over by its gui.
        iface.focus.expect("echo-c1");
        driver({ type: "configure", from: ["$proc", "cq", "2"], sticky: true, id: "c1" });
        await new Promise((resolve) => setTimeout(resolve, 0));
        const box = document.querySelector("#echo-c1")!;
        expect(iface.focus.current).toBe(box);

        driver({ type: "configure", from: ["$proc", "cq", "2", "$frame"], kind: "frame" });
        driver({
            type: "send",
            from: ["$proc", "cq", "2", "$frame"],
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
        driver({ type: "configure", kind: "prompt", from: ["$proc", "cq"], label: "cq" });
        await new Promise((resolve) => setTimeout(resolve, 0));
        const pc = document.querySelector<PromptCollection>("prompt-collection")!;
        const promptEl = pc.promptElement(pc.prompts[0])!;

        driver({ type: "configure", from: ["$proc", "cq", "2"], sticky: true });
        const box = document.querySelector<EchoBox>("echo-box")!;
        const inner = document.createElement("div");
        inner.setAttribute("focusable", "cell");
        inner.tabIndex = -1;
        box.append(inner);
        iface.focus.focus(promptEl, "api");
        iface.focus.focus(inner, "api");
        driver({ type: "configure", from: ["$proc", "cq", "2", "$frame"], kind: "frame" });
        driver({
            type: "send",
            from: ["$proc", "cq", "2", "$frame"],
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
        driver({ type: "configure", kind: "frame", from: ["p"] });
        driver({ type: "send", from: ["p"], message: { type: "data", data: {} } });
        const gui = document.querySelector<BucheGui>("buche-gui")!;
        // What Alt+Q does to the focus: it lands on the <buche-gui> host.
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

// ── interface: cell kinds ────────────────────────────────────────────────────

describe("cell kinds", () => {
    function setup() {
        const container = document.createElement("div");
        document.body.append(container);
        const iface = new BucheInterface({ container });
        const buche: Buche = new Buche({
            sendDriver: () => {},
            sendInterface: (m) => iface.processMessage(buche, m),
        });
        const driver = (m: Record<string, unknown>) =>
            buche.handle({ to: ["$term"], ...m } as InM);
        return { iface, buche, driver };
    }

    test("a frame cell shows its gui right away, with no terminal", () => {
        const { iface, driver } = setup();
        driver({ type: "configure", from: ["p"], kind: "frame" });
        const gui = document.querySelector<BucheGui>("buche-gui");
        expect(gui).not.toBeNull();
        expect(document.querySelector("embedded-term")).toBeNull();
        expect(iface.focus.current).toBe(gui);
    });

    test("a terminal cell shows its terminal right away, and takes no frame content", () => {
        const { driver } = setup();
        driver({ type: "configure", from: ["p"], kind: "terminal" });
        expect(document.querySelectorAll("embedded-term").length).toBe(1);
        driver({ type: "send", from: ["p"], message: { type: "data", data: {} } });
        const box = document.querySelector<EchoBox>("echo-box")!;
        expect(box.content?.localName).toBe("embedded-term");
    });

    test("a frame cell claiming a placeholder replaces its terminal", () => {
        const { driver } = setup();
        driver({ type: "configure", from: ["p"], label: "p" });
        expect(document.querySelectorAll("embedded-term").length).toBe(1);
        driver({ type: "configure", from: ["p", "$frame"], kind: "frame" });
        const box = document.querySelector<EchoBox>("echo-box")!;
        expect(box.content).toBeInstanceOf(BucheGui);
        expect(document.querySelectorAll("echo-box").length).toBe(1);
    });

    test("a terminal cell claiming a placeholder keeps its terminal", () => {
        const { buche, driver } = setup();
        driver({ type: "configure", from: ["p"], label: "p" });
        const term = document.querySelector("embedded-term");
        driver({ type: "configure", from: ["p", "$stdout"], kind: "terminal" });
        expect(buche.get(["p", "$stdout"]).cell?.kind).toBe("terminal");
        expect(document.querySelector("embedded-term")).toBe(term);
    });

    test("a prompt cell is a prompt", () => {
        const { buche, driver } = setup();
        driver({ type: "configure", from: ["cq"], kind: "prompt", label: "cq" });
        expect(buche.get(["cq"]).cell.kind).toBe("prompt");
        expect(buche.get(["cq"]).cell?.kind).toBe("prompt");
    });
});
