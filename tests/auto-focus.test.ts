// @vitest-environment happy-dom

// Automatic focus across the machine and the interface: a prompt command's id
// travels to the driver and back on the echo, whose cell then takes the focus
// (unless `background`), and gives it back when its process ends (unless
// `sticky`); a new prompt takes the focus unless `background`.

import { panes as panesOf } from "carreau/src/model";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { EchoBox } from "../src/components/echo-box.tsx";
import { EmbeddedTerm } from "../src/components/embedded-term.tsx";
import type { PromptCollection } from "../src/components/prompt-collection.tsx";
import { Buche, type InM } from "../src/core.ts";
import type { OutgoingDriverMessage } from "../src/driver-exchange/outgoing.ts";
import { BucheInterface } from "../src/interface.tsx";

afterEach(() => {
    document.body.replaceChildren();
});

// Whether an element shows (happy-dom's checkVisibility ignores `hidden`,
// which the layout uses for what isn't shown).
const shown = (el: Element | null | undefined) =>
    !!el && el.isConnected && !el.closest("[hidden]");

// Let MutationObservers deliver, then the microtasks they schedule run.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const TERM = ["$term"];
const SHELL = ["$proc", "cq"];

function setup() {
    const container = document.createElement("div");
    document.body.append(container);
    const iface = new BucheInterface({ container });
    const sent: OutgoingDriverMessage[] = [];
    const buche: Buche = new Buche({
        sendDriver: (m) => sent.push(m),
        sendInterface: (m) => iface.processMessage(buche, m),
    });
    // Feed what the interface queued (user actions) to the machine.
    const flush = () => {
        for (const m of iface.interactions.purge()) {
            buche.handle(m as InM);
        }
    };
    const driver = (m: Record<string, unknown>) => buche.handle({ to: TERM, ...m } as InM);
    return { container, iface, buche, sent, flush, driver };
}

function prompt(container: HTMLElement, label = "cq"): HTMLElement {
    for (const pc of container.querySelectorAll<PromptCollection>("prompt-collection")) {
        const entry = pc.prompts.find((e) => e.echo.label === label);
        if (entry) {
            return pc.promptElement(entry)!;
        }
    }
    throw new Error(`no prompt ${label}`);
}

// The shell's prompt, then a submitted command answered by a cell.
function run(
    ctx: ReturnType<typeof setup>,
    echo: Record<string, unknown> = {},
    cell: Record<string, unknown> = {},
): { id: string; box: () => EchoBox | null } {
    const { iface, sent, flush, driver, container } = ctx;
    const entry = (prompt(container).closest("prompt-collection") as PromptCollection).prompts[0];
    iface.pushCommand({
        command: "submit",
        entry,
        text: "ls",
        selection: { start: 2, end: 2 },
        event: new KeyboardEvent("keydown"),
    });
    flush();
    const request = sent.at(-1) as OutgoingDriverMessage & { id?: string };
    expect(request.type).toBe("command");
    const id = request.id as string;
    const from = [...SHELL, "2"];
    driver({ type: "cell_configure", from, zone: null, id, ...echo, ...cell });
    return { id, box: () => container.querySelector(`#echo-${id}`) };
}

describe("automatic focus", () => {
    test("a new prompt takes the focus", async () => {
        const { container, iface, driver } = setup();
        driver({ type: "prompt_configure", from: SHELL, label: "cq" });
        await settle();
        expect(iface.focus.current).toBe(prompt(container));
        expect(iface.focus.currentTags).toEqual(["prompt", "auto"]);
    });

    test("a background prompt doesn't", async () => {
        const { iface, driver } = setup();
        driver({ type: "prompt_configure", from: SHELL, label: "cq", background: true });
        await settle();
        expect(iface.focus.current).toBeNull();
    });

    test("the command's id goes to the driver, and its echo's cell takes the focus", async () => {
        const ctx = setup();
        ctx.driver({ type: "prompt_configure", from: SHELL, label: "cq" });
        const { id, box } = run(ctx);
        expect(id).toMatch(/.+/);
        await settle();
        expect(box()).not.toBeNull();
        expect(ctx.iface.focus.current).toBe(box());
        expect(ctx.iface.focus.currentTags).toEqual(["cell", "auto"]);
    });

    test("a background echo leaves the focus alone", async () => {
        const ctx = setup();
        ctx.driver({ type: "prompt_configure", from: SHELL, label: "cq" });
        await settle();
        const { box } = run(ctx, { background: true });
        await settle();
        expect(box()).not.toBeNull();
        expect(ctx.iface.focus.expecting).toBeNull();
        expect(ctx.iface.focus.current).toBe(prompt(ctx.container));
    });

    test("when the focused cell's process ends, the focus goes back", async () => {
        const ctx = setup();
        ctx.driver({ type: "prompt_configure", from: SHELL, label: "cq" });
        await settle();
        const { box } = run(ctx);
        await settle();
        expect(ctx.iface.focus.current).toBe(box());

        ctx.driver({ type: "close", from: [...SHELL, "2"], outcome: { type: "success" } });
        await settle();
        expect(ctx.iface.focus.current).toBe(prompt(ctx.container));
    });

    test("a terminal created in the focused cell gets the focus", async () => {
        const focus = vi.spyOn(EmbeddedTerm.prototype, "focus").mockImplementation(() => {});
        try {
            const ctx = setup();
            ctx.driver({ type: "prompt_configure", from: SHELL, label: "cq" });
            await settle();
            const { box } = run(ctx);
            await settle();
            expect(ctx.iface.focus.current).toBe(box());
            expect(focus).not.toHaveBeenCalled();

            // The driver's initial empty text creates the terminal.
            ctx.driver({ type: "text", from: [...SHELL, "2"], stream: "stdout", text: "" });
            await settle();
            expect(box()?.querySelector("embedded-term")).not.toBeNull();
            expect(focus).toHaveBeenCalledTimes(1);
        } finally {
            focus.mockRestore();
        }
    });

    test("unless the echo is sticky", async () => {
        const ctx = setup();
        ctx.driver({ type: "prompt_configure", from: SHELL, label: "cq" });
        await settle();
        const { box } = run(ctx, { sticky: true });
        await settle();

        ctx.driver({ type: "close", from: [...SHELL, "2"], outcome: { type: "success" } });
        await settle();
        expect(ctx.iface.focus.current).toBe(box());
    });

    test("moving the focus before the echo arrives cancels its focus", async () => {
        const ctx = setup();
        ctx.driver({ type: "prompt_configure", from: SHELL, label: "cq" });
        await settle();
        const entry = (prompt(ctx.container).closest("prompt-collection") as PromptCollection)
            .prompts[0];
        ctx.iface.pushCommand({
            command: "submit",
            entry,
            text: "ls",
            selection: { start: 2, end: 2 },
            event: new KeyboardEvent("keydown"),
        });
        ctx.flush();
        const id = (ctx.sent.at(-1) as { id: string }).id;
        // The user clicks elsewhere before the cell arrives. (Clicking the
        // prompt again wouldn't count: the focus has to move.)
        const other = document.createElement("div");
        other.setAttribute("focusable", "cell");
        ctx.container.append(other);
        ctx.iface.focus.focus(other, "click");
        const from = [...SHELL, "2"];
        ctx.driver({ type: "cell_configure", from, zone: null, id });
        await settle();
        expect(ctx.container.querySelector(`#echo-${id}`)).not.toBeNull();
        expect(ctx.iface.focus.current).toBe(other);
    });

    test("a cell in a new tab takes the focus there", async () => {
        const ctx = setup();
        ctx.driver({ type: "prompt_configure", from: SHELL, label: "cq" });
        await settle();
        const { box } = run(ctx, { label: "sleep" }, { zone: "tab" });
        await settle();
        const cell = box();
        expect(cell?.closest(".carreau-scroll")).toBeNull();
        expect(shown(cell)).toBe(true);
        expect(ctx.iface.focus.current).toBe(cell);
        expect(ctx.container.querySelectorAll(`#${cell?.id}`)).toHaveLength(1);
    });

    test("focusPrompt brings the prompt's tab back after a cell took the focus in a new tab", async () => {
        const ctx = setup();
        ctx.driver({ type: "prompt_configure", from: SHELL, label: "cq" });
        await settle();
        run(ctx, { label: "sleep" }, { zone: "tab" });
        await settle();
        expect(shown(prompt(ctx.container))).toBe(false);

        ctx.iface.focusPrompt();
        expect(shown(prompt(ctx.container))).toBe(true);
        expect(ctx.iface.focus.current).toBe(prompt(ctx.container));
    });

    test("a background cell's new tab stays in the background", async () => {
        const ctx = setup();
        ctx.driver({ type: "prompt_configure", from: SHELL, label: "cq" });
        await settle();
        const { box } = run(ctx, { label: "sleep", background: true }, { zone: "tab" });
        await settle();
        expect(shown(box())).toBe(false);
        expect(ctx.iface.focus.current).toBe(prompt(ctx.container));
    });
});

describe("tab ✕", () => {
    const tabClose = (container: HTMLElement, label: string) => {
        const tab = [...container.querySelectorAll(".carreau-tab")].find(
            (t) => t.querySelector(".carreau-tab-short")?.textContent === label,
        );
        return tab?.querySelector<HTMLElement>(".carreau-tab-close") ?? null;
    };
    const hasTab = (container: HTMLElement, label: string) =>
        [...container.querySelectorAll(".carreau-tab-short")].some((t) => t.textContent === label);

    test("ends the cell's process; the tab goes when it has ended", async () => {
        const ctx = setup();
        ctx.driver({ type: "prompt_configure", from: SHELL, label: "cq" });
        await settle();
        const { box } = run(ctx, { label: "sleep" }, { zone: "tab" });
        await settle();
        const entry = box()?.boundEntry;
        ctx.iface.interactions.purge();

        tabClose(ctx.container, "sleep")?.click();
        expect([...ctx.iface.interactions.purge()]).toEqual([
            // Running (cell_configure says so): SIGTERM.
            { type: "user_signal", code: 15, entry },
        ]);
        // Closing meanwhile (a spinner instead of the ✕).
        expect(hasTab(ctx.container, "sleep")).toBe(true);
        expect(tabClose(ctx.container, "sleep")).toBeNull();

        ctx.driver({ type: "close", from: [...SHELL, "2"], outcome: { type: "error" } });
        await settle();
        await settle();
        expect(box()).toBeNull();
        expect(hasTab(ctx.container, "sleep")).toBe(false);
        // The layout puts the focus where it belongs: back on the prompt.
        expect(ctx.iface.focus.current).toBe(prompt(ctx.container));
    });

    test("on an ended cell's tab, removes it right away", async () => {
        const ctx = setup();
        ctx.driver({ type: "prompt_configure", from: SHELL, label: "cq" });
        await settle();
        run(ctx, { label: "sleep", background: true }, { zone: "tab" });
        ctx.driver({ type: "close", from: [...SHELL, "2"], outcome: { type: "success" } });
        await settle();
        expect(hasTab(ctx.container, "sleep")).toBe(true);

        tabClose(ctx.container, "sleep")?.click();
        await settle();
        expect(hasTab(ctx.container, "sleep")).toBe(false);
    });

    test("a process with two tabs ends with the last one", async () => {
        const ctx = setup();
        ctx.driver({ type: "prompt_configure", from: SHELL, label: "cq" });
        const proc = [...SHELL, "2"];
        ctx.driver({ type: "configure", from: proc, zone: "tab", label: "app" });
        ctx.driver({ type: "text", from: [...proc, "$stdout"], stream: "stdout", text: "x" });
        ctx.driver({ type: "data", from: [...proc, "$gui"], data: 1 });
        await settle();
        const tabs = () =>
            [...ctx.container.querySelectorAll(".carreau-tab")].filter(
                (t) => shown(t) && t.textContent?.startsWith("app"),
            );
        expect(tabs()).toHaveLength(2);
        ctx.iface.interactions.purge();
        tabs()[1].querySelector<HTMLElement>(".carreau-tab-close")?.click();
        await settle();
        const signals = () =>
            [...ctx.iface.interactions.purge()].filter((m: any) => m.type === "user_signal");
        expect(signals()).toEqual([]);
        expect(tabs()).toHaveLength(1);
        tabs()[0].querySelector<HTMLElement>(".carreau-tab-close")?.click();
        expect(signals().map((m: any) => m.code)).toEqual([15]);
    });
});

describe("placement", () => {
    test("reserved zones are relative to where the command came from; names are panes", async () => {
        const ctx = setup();
        const { driver, iface } = ctx;
        const ws = iface.layout.ws;
        const paneOf = (label: string) => {
            for (const t of ws.trees()) {
                for (const p of panesOf(t)) {
                    if (p.tabs.some((tab: any) => tab.title === label)) {
                        return p;
                    }
                }
            }
            return null;
        };
        driver({ type: "prompt_configure", from: SHELL, label: "cq" });
        const main = paneOf("cq");
        expect(main?.name).toBe("main");

        // `@left coquille`: the sub-shell's placeholder goes in a new pane on
        // the left, and its prompt takes its place there.
        const sub = [...SHELL, "1"];
        driver({ type: "configure", from: sub, zone: "@left", label: "coquille" });
        driver({ type: "prompt_configure", from: [...sub, "cq"], label: "sub" });
        const left = paneOf("sub");
        expect(left).not.toBeNull();
        expect(left).not.toBe(paneOf("cq"));
        expect(paneOf("coquille")).toBeNull();

        // From the sub-shell, `@r ls` goes back right, into the main pane.
        driver({ type: "cell_configure", from: [...sub, "cq", "2"], zone: "@r", label: "right" });
        expect(paneOf("right")).toBe(paneOf("cq"));
        // `@tab` beside its prompt, in its pane.
        driver({
            type: "cell_configure",
            from: [...sub, "cq", "3"],
            zone: "tab",
            label: "tabbed",
        });
        expect(paneOf("tabbed")).toBe(paneOf("sub"));
        // Inline: in the sub-shell's stream.
        driver({ type: "cell_configure", from: [...sub, "cq", "4"], label: "plain" });
        expect(
            iface.layout.boxOf(ctx.buche.get([...sub, "cq", "4"]))?.closest(".carreau-scroll"),
        ).not.toBeNull();
        // Names: an existing pane, or a new one.
        driver({ type: "cell_configure", from: [...sub, "cq", "5"], zone: "main", label: "far" });
        expect(paneOf("far")).toBe(paneOf("cq"));
        driver({
            type: "cell_configure",
            from: [...sub, "cq", "6"],
            zone: "logs",
            label: "logged",
        });
        expect(paneOf("logged")?.name).toBe("logs");
    });

    test("a nested shell started inline gets a tab linked to its parent's", async () => {
        const ctx = setup();
        const { driver, iface } = ctx;
        driver({ type: "prompt_configure", from: SHELL, label: "cq" });
        const sub = [...SHELL, "1"];
        driver({ type: "configure", from: sub, label: "coquille" });
        driver({ type: "prompt_configure", from: [...sub, "cq"], label: "sub" });
        await settle();
        const tabs = [...ctx.container.querySelectorAll(".carreau-tab")].filter(shown);
        const labels = tabs.map((t) => t.querySelector(".carreau-tab-short")?.textContent);
        expect(labels).toEqual(["cq", "sub"]);
        expect(tabs.every((t) => t.classList.contains("linked"))).toBe(true);
        // The sub-shell's commands go in the merged stream.
        driver({ type: "cell_configure", from: [...sub, "cq", "2"], label: "ls" });
        await settle();
        expect(shown(iface.layout.boxOf(ctx.buche.get([...sub, "cq", "2"])))).toBe(true);
    });
});

describe("a shell ending", () => {
    const labels = (container: HTMLElement) =>
        [...container.querySelectorAll(".carreau-tab-short")]
            .filter(shown)
            .map((t) => t.textContent);

    test("leaves its sub-shell and its running commands alone", async () => {
        const ctx = setup();
        const { driver, iface, container } = ctx;
        driver({ type: "prompt_configure", from: SHELL, label: "cq" });
        driver({ type: "cell_configure", from: [...SHELL, "2"], label: "sleep" });
        const sub = [...SHELL, "3"];
        driver({ type: "configure", from: sub, label: "coquille" });
        driver({ type: "prompt_configure", from: [...sub, "cq"], label: "sub" });
        await settle();
        expect(labels(container)).toEqual(["cq", "sub"]);
        iface.interactions.purge();

        // Ctrl+D in the outer shell: it ends, not what runs under it.
        driver({ type: "close", from: SHELL, propagate: false, outcome: { type: "success" } });
        await settle();
        await settle();
        expect(labels(container)).toEqual(["sub"]);
        expect(
            [...iface.interactions.purge()].filter((m: any) => m.type === "user_signal"),
        ).toEqual([]);
        // Its cells went to the sub-shell's stream, the running one included.
        expect(shown(iface.layout.boxOf(ctx.buche.get([...SHELL, "2"])))).toBe(true);
    });

    test("alone, its tab stays while a command still runs in it", async () => {
        const ctx = setup();
        const { driver, iface, container } = ctx;
        driver({ type: "prompt_configure", from: SHELL, label: "cq" });
        driver({ type: "prompt_configure", from: ["$proc", "other"], label: "other" });
        driver({ type: "cell_configure", from: [...SHELL, "2"], label: "sleep" });
        await settle();
        iface.interactions.purge();

        driver({ type: "close", from: SHELL, propagate: false, outcome: { type: "success" } });
        await settle();
        expect(labels(container)).toEqual(["cq", "other"]);
        expect(
            [...iface.interactions.purge()].filter((m: any) => m.type === "user_signal"),
        ).toEqual([]);

        driver({ type: "close", from: [...SHELL, "2"], outcome: { type: "success" } });
        await settle();
        await settle();
        expect(labels(container)).toEqual(["other"]);
    });
});

describe("slots", () => {
    const pick = (chooser: Element, key: string) =>
        chooser.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));

    test("an empty named pane offers a shell, which goes there", async () => {
        const ctx = setup();
        const { driver, iface, container } = ctx;
        driver({ type: "prompt_configure", from: SHELL, label: "cq" });
        driver({ type: "cell_configure", from: [...SHELL, "2"], zone: "logs", label: "x" });
        driver({ type: "close", from: [...SHELL, "2"], outcome: { type: "success" } });
        const ws = iface.layout.ws;
        await ws.closeTab(ws.paneByName("logs")!.tabs[0].id);
        await settle();
        const chooser = container.querySelector("slot-chooser")!;
        expect(shown(chooser)).toBe(true);
        iface.focus.focus(prompt(container));
        iface.interactions.purge();

        pick(chooser, "3");
        const [command] = [...iface.interactions.purge()] as any[];
        const zone = `~${ws.paneByName("logs")!.id}`;
        expect(command).toMatchObject({ type: "user_command", text: "cq", command: "run", zone });
        // The shell's placeholder, then its prompt, go into the pane.
        const sub = [...SHELL, "3"];
        driver({ type: "configure", from: sub, zone, label: "cq" });
        driver({ type: "prompt_configure", from: [...sub, "cq"], label: "sub" });
        expect(ws.paneByName("logs")!.tabs.map((t) => t.title)).toEqual(["sub"]);
    });

    test("insert offers a new scroll column, named at random, empty, which stays", async () => {
        const ctx = setup();
        const { driver, iface, container } = ctx;
        driver({ type: "prompt_configure", from: SHELL, label: "cq" });
        const ws = iface.layout.ws;
        ws.select({ id: iface.layout.promptNodeOf(ctx.buche.get(SHELL))! });
        iface.layout.insert();
        await settle();
        const chooser = [...container.querySelectorAll("slot-chooser")].find(shown)!;
        pick(chooser, "1");
        await settle();
        // (Its name is then edited in its tab: see View.editTabTitle.)
        const named = (t: { title: string }) => /^[a-z]+-[a-z]+$/.test(t.title);
        const tab = ws.root.type === "pane" ? ws.root.tabs.find(named) : undefined;
        const stream = tab?.group?.children[0];
        expect(stream?.type).toBe("scroll-column");
        expect(stream && "children" in stream && stream.children).toEqual([]);
        expect([...container.querySelectorAll("slot-chooser")].filter(shown)).toHaveLength(0);
    });

    test("typing in a slot runs a command there, from the last prompt", async () => {
        const ctx = setup();
        const { driver, iface, container } = ctx;
        driver({ type: "prompt_configure", from: SHELL, label: "cq" });
        iface.focus.focus(prompt(container));
        iface.layout.insert("right", true);
        await settle();
        const chooser = [...container.querySelectorAll("slot-chooser")].find(shown)!;
        iface.interactions.purge();
        for (const key of "ls") {
            pick(chooser, key);
        }
        const field = chooser.querySelector("input")!;
        expect(field.value).toBe("ls");
        field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        const [command] = [...iface.interactions.purge()] as any[];
        expect(command).toMatchObject({ type: "user_command", text: "ls", command: "run" });
        expect(command.zone).toMatch(/^~/);
    });

    test("with no prompt, the shell is one of its own", async () => {
        const ctx = setup();
        const { iface, container } = ctx;
        await settle();
        const chooser = [...container.querySelectorAll("slot-chooser")].find(shown)!;
        pick(chooser, "3");
        const [spawn] = [...iface.interactions.purge()] as any[];
        expect(spawn).toMatchObject({ type: "user_spawn", command: "cq" });
        // The machine starts it at an address of its own, its prompt going there.
        const sent: any[] = [];
        ctx.buche.sendDriver = (m) => sent.push(m);
        ctx.buche.handle(spawn);
        expect(sent).toEqual([{ type: "spawn", from: ["$term"], to: ["$d1"], command: "cq" }]);
        ctx.driver({ type: "prompt_configure", from: ["$d1", "$proc", "cq"], label: "cq" });
        expect(iface.layout.ws.paneByName("main")!.tabs.map((t) => t.title)).toEqual(["cq"]);
    });
});
