// @vitest-environment happy-dom

// Automatic focus across the machine and the interface: a prompt command's id
// travels to the driver and back on the echo, whose cell then takes the focus
// (unless `background`), and gives it back when its process ends (unless
// `sticky`); a new prompt takes the focus unless `background`.

import { afterEach, describe, expect, test, vi } from "vitest";
import type { EchoBox } from "../src/components/echo-box.tsx";
import { EmbeddedTerm } from "../src/components/embedded-term.tsx";
import type { PromptCollection } from "../src/components/prompt-collection.tsx";
import { TabbedZoneElement } from "../src/components/zone.tsx";
import { Buche, type InM } from "../src/core.ts";
import type { OutgoingDriverMessage } from "../src/driver-exchange/outgoing.ts";
import { BucheInterface } from "../src/interface.tsx";
import { zoneMap } from "../src/zone.ts";

afterEach(() => {
    document.body.replaceChildren();
});

// Let MutationObservers deliver, then the microtasks they schedule run.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const TERM = ["$term"];
const SHELL = ["$proc", "cq"];

function setup() {
    const container = document.createElement("div");
    // (Names passed explicitly: parsed markup would construct the element
    // before its `names` attribute is set.)
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

// The shell's prompt, then a submitted command answered by an echo + cell.
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
        position: 2,
        event: new KeyboardEvent("keydown"),
    });
    flush();
    const request = sent.at(-1) as OutgoingDriverMessage & { id?: string };
    expect(request.type).toBe("command");
    const id = request.id as string;
    const from = [...SHELL, "2"];
    driver({ type: "echo", from, id, echo: { text: "ls", ranges: [] }, ...echo });
    driver({ type: "cell_configure", from, zone: null, ...cell });
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
            position: 2,
            event: new KeyboardEvent("keydown"),
        });
        ctx.flush();
        const id = (ctx.sent.at(-1) as { id: string }).id;
        // The user clicks elsewhere before the echo arrives. (Clicking the
        // prompt again wouldn't count: the focus has to move.)
        const other = document.createElement("div");
        other.setAttribute("focusable", "cell");
        ctx.container.append(other);
        ctx.iface.focus.focus(other, "click");
        const from = [...SHELL, "2"];
        ctx.driver({ type: "echo", from, id, echo: { text: "ls", ranges: [] } });
        ctx.driver({ type: "cell_configure", from, zone: null });
        await settle();
        expect(ctx.container.querySelector(`#echo-${id}`)).not.toBeNull();
        expect(ctx.iface.focus.current).toBe(other);
    });

    test("a cell in a new tab takes the focus there (not its echo in the log)", async () => {
        const ctx = setup();
        ctx.driver({ type: "prompt_configure", from: SHELL, label: "cq" });
        await settle();
        const { box } = run(ctx, { label: "sleep" }, { zone: "tab" });
        await settle();
        const cell = box();
        expect(cell?.closest(".tab-pane-pane")).not.toBeNull();
        expect(ctx.iface.focus.current).toBe(cell);
        // Only the cell carries the id; the echo in the prompt's log doesn't.
        expect(ctx.container.querySelectorAll(`#${cell?.id}`)).toHaveLength(1);
    });

    test("focusPrompt brings the prompt's tab back after a cell took the focus in a new tab", async () => {
        const ctx = setup();
        ctx.driver({ type: "prompt_configure", from: SHELL, label: "cq" });
        await settle();
        run(ctx, { label: "sleep" }, { zone: "tab" });
        await settle();
        expect(prompt(ctx.container).checkVisibility()).toBe(false);

        ctx.iface.focusPrompt();
        expect(prompt(ctx.container).checkVisibility()).toBe(true);
        expect(ctx.iface.focus.current).toBe(prompt(ctx.container));
    });

    test("a background cell's new tab stays in the background", async () => {
        const ctx = setup();
        ctx.driver({ type: "prompt_configure", from: SHELL, label: "cq" });
        await settle();
        const { box } = run(ctx, { label: "sleep", background: true }, { zone: "tab" });
        await settle();
        expect(box()?.checkVisibility()).toBe(false);
        expect(ctx.iface.focus.current).toBe(prompt(ctx.container));
    });
});

describe("tab ✕", () => {
    const tabClose = (container: HTMLElement, label: string) => {
        const tab = [...container.querySelectorAll(".tab-pane-tab")].find(
            (t) => t.querySelector(".tab-pane-tab-label")?.textContent === label,
        );
        return tab?.querySelector<HTMLElement>(".tab-pane-tab-close") ?? null;
    };

    test("on a cell's tab, acts like the cell's ✕; the tab goes when the cell does", async () => {
        const ctx = setup();
        ctx.driver({ type: "prompt_configure", from: SHELL, label: "cq" });
        await settle();
        const { box } = run(ctx, { label: "sleep" }, { zone: "tab" });
        await settle();
        const entry = box()?.boundEntry;
        ctx.iface.interactions.purge();

        tabClose(ctx.container, "sleep")?.click();
        expect([...ctx.iface.interactions.purge()]).toEqual([
            // Running (cell_configure says so): SIGTERM, as from the cell's ✕.
            { type: "user_signal", code: 15, entry },
        ]);
        expect(tabClose(ctx.container, "sleep")).not.toBeNull();

        ctx.driver({ type: "close", from: [...SHELL, "2"], outcome: { type: "error" } });
        await settle();
        expect(box()).toBeNull();
        expect(tabClose(ctx.container, "sleep")).toBeNull();
        // The tab that was shown before comes back, with the focus.
        expect(ctx.iface.focus.current).toBe(prompt(ctx.container));
    });

    test("on an ended cell's tab, removes it right away", async () => {
        const ctx = setup();
        ctx.driver({ type: "prompt_configure", from: SHELL, label: "cq" });
        await settle();
        run(ctx, { label: "sleep", background: true }, { zone: "tab" });
        ctx.driver({ type: "close", from: [...SHELL, "2"], outcome: { type: "success" } });
        await settle();
        expect(tabClose(ctx.container, "sleep")).not.toBeNull();

        tabClose(ctx.container, "sleep")?.click();
        expect(tabClose(ctx.container, "sleep")).toBeNull();
    });
});

describe("zone lookup", () => {
    test("bubbles up through the zones entries were placed in, before the layout's", () => {
        const container = document.createElement("div");
        // Two tabbed zones, both named "tab" among others; in the layout-wide
        // registry, "tab" is the last one (main).
        const left = new TabbedZoneElement(["left"]);
        const main = new TabbedZoneElement(["@", "main"]);
        container.append(left, main);
        document.body.append(container);
        const iface = new BucheInterface({ container, template: container });
        const buche: Buche = new Buche({
            initialZones: zoneMap(iface.zones),
            sendDriver: () => {},
            sendInterface: (m) => iface.processMessage(buche, m),
        });
        const driver = (m: Record<string, unknown>) => buche.handle({ to: TERM, ...m } as InM);
        const zoneOf = (label: string) =>
            [...container.querySelectorAll("echo-box")]
                .find((b) => (b as EchoBox).boundEntry?.echo.label === label)
                ?.closest("tabbed-zone");

        driver({ type: "prompt_configure", from: SHELL, label: "cq" });
        // `@left coquille`: the sub-shell's cell and prompt go to the left zone.
        const sub = [...SHELL, "1"];
        driver({ type: "cell_configure", from: sub, zone: "left", label: "coquille" });
        driver({ type: "prompt_configure", from: [...sub, "cq"], zone: "left", label: "sub" });

        // In the sub-shell: `@tab ls` goes to a tab of the left zone, where the
        // sub-shell lives; a plain command goes to the sub-shell's log.
        driver({
            type: "cell_configure",
            from: [...sub, "cq", "2"],
            zone: "tab",
            label: "tabbed",
        });
        driver({ type: "cell_configure", from: [...sub, "cq", "3"], zone: null, label: "plain" });
        expect(zoneOf("tabbed")).toBe(left);
        expect(zoneOf("plain")).toBe(left);
        expect(
            [...container.querySelectorAll("echo-box")]
                .find((b) => (b as EchoBox).boundEntry?.echo.label === "plain")
                ?.closest("buche-term")
                ?.querySelector(".prompt-collection-tab")?.textContent,
        ).toBe("sub");

        // From the main shell, `@tab ls` goes to the main zone's tabs.
        driver({ type: "cell_configure", from: [...SHELL, "4"], zone: "tab", label: "main-tab" });
        expect(zoneOf("main-tab")).toBe(main);
        // And explicit names still resolve from anywhere.
        driver({ type: "cell_configure", from: [...sub, "cq", "5"], zone: "main", label: "far" });
        expect(zoneOf("far")).toBe(main);
    });
});
