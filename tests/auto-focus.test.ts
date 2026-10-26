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
        const entry = pc.prompts.find((e) => e.cell.label.text === label);
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
    driver({ type: "configure", kind: "terminal", from, zone: null, id, ...echo, ...cell });
    return { id, box: () => container.querySelector(`#echo-${id}`) };
}

/** Interactions, but the size reports (a terminal's, whenever the layout
 *  moves it). */
function withoutResizes<T extends { type: string }>(interactions: Iterable<T>): T[] {
    return [...interactions].filter((i) => i.type !== "user_resize");
}

describe("automatic focus", () => {
    test("a new prompt takes the focus", async () => {
        const { container, iface, driver } = setup();
        driver({ type: "configure", kind: "prompt", from: SHELL, label: "cq" });
        await settle();
        expect(iface.focus.current).toBe(prompt(container));
        expect(iface.focus.currentTags).toEqual(["prompt", "auto"]);
    });

    test("a background prompt doesn't", async () => {
        const { iface, driver } = setup();
        driver({ type: "configure", kind: "prompt", from: SHELL, label: "cq", background: true });
        await settle();
        expect(iface.focus.current).toBeNull();
    });

    test("the command's id goes to the driver, and its echo's cell takes the focus", async () => {
        const ctx = setup();
        ctx.driver({ type: "configure", kind: "prompt", from: SHELL, label: "cq" });
        const { id, box } = run(ctx);
        expect(id).toMatch(/.+/);
        await settle();
        expect(box()).not.toBeNull();
        expect(ctx.iface.focus.current).toBe(box());
        expect(ctx.iface.focus.currentTags).toEqual(["cell", "auto"]);
    });

    test("a background echo leaves the focus alone", async () => {
        const ctx = setup();
        ctx.driver({ type: "configure", kind: "prompt", from: SHELL, label: "cq" });
        await settle();
        const { box } = run(ctx, { background: true });
        await settle();
        expect(box()).not.toBeNull();
        expect(ctx.iface.focus.expecting).toBeNull();
        expect(ctx.iface.focus.current).toBe(prompt(ctx.container));
    });

    test("when the focused cell's process ends, the focus goes back", async () => {
        const ctx = setup();
        ctx.driver({ type: "configure", kind: "prompt", from: SHELL, label: "cq" });
        await settle();
        const { box } = run(ctx);
        await settle();
        expect(ctx.iface.focus.current).toBe(box());

        ctx.driver({ type: "close", from: [...SHELL, "2"], outcome: { type: "success" } });
        await settle();
        expect(ctx.iface.focus.current).toBe(prompt(ctx.container));
    });

    test("but not out of a prompt's stream (in a tab of its own)", async () => {
        const ctx = setup();
        ctx.driver({ type: "configure", kind: "prompt", from: SHELL, label: "cq" });
        await settle();
        const { box } = run(ctx, { label: "sleep" }, { zone: "tab" });
        await settle();
        expect(ctx.iface.focus.current).toBe(box());

        ctx.driver({ type: "close", from: [...SHELL, "2"], outcome: { type: "success" } });
        await settle();
        expect(ctx.iface.focus.current).toBe(box());
    });

    test("a terminal created in the focused cell gets the focus", async () => {
        const focus = vi.spyOn(EmbeddedTerm.prototype, "focus").mockImplementation(() => {});
        try {
            const ctx = setup();
            ctx.driver({ type: "configure", kind: "prompt", from: SHELL, label: "cq" });
            await settle();
            // A terminal cell has its terminal from the start.
            const { box } = run(ctx);
            await settle();
            expect(ctx.iface.focus.current).toBe(box());
            expect(box()?.querySelector("embedded-term")).not.toBeNull();
            expect(focus).toHaveBeenCalled();
            const calls = focus.mock.calls.length;

            // Output goes to it, and does not focus it again.
            ctx.driver({
                type: "send",
                from: [...SHELL, "2"],
                message: { type: "text", stream: "stdout", text: "" },
            });
            await settle();
            expect(focus).toHaveBeenCalledTimes(calls);
        } finally {
            focus.mockRestore();
        }
    });

    test("unless the echo is sticky", async () => {
        const ctx = setup();
        ctx.driver({ type: "configure", kind: "prompt", from: SHELL, label: "cq" });
        await settle();
        const { box } = run(ctx, { sticky: true });
        await settle();

        ctx.driver({ type: "close", from: [...SHELL, "2"], outcome: { type: "success" } });
        await settle();
        expect(ctx.iface.focus.current).toBe(box());
    });

    test("moving the focus before the echo arrives cancels its focus", async () => {
        const ctx = setup();
        ctx.driver({ type: "configure", kind: "prompt", from: SHELL, label: "cq" });
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
        ctx.driver({ type: "configure", kind: "terminal", from, zone: null, id });
        await settle();
        expect(ctx.container.querySelector(`#echo-${id}`)).not.toBeNull();
        expect(ctx.iface.focus.current).toBe(other);
    });

    test("a cell in a new tab takes the focus there", async () => {
        const ctx = setup();
        ctx.driver({ type: "configure", kind: "prompt", from: SHELL, label: "cq" });
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
        ctx.driver({ type: "configure", kind: "prompt", from: SHELL, label: "cq" });
        await settle();
        run(ctx, { label: "sleep" }, { zone: "tab" });
        await settle();
        expect(shown(prompt(ctx.container))).toBe(false);

        ctx.iface.focusPrompt();
        expect(shown(prompt(ctx.container))).toBe(true);
        expect(ctx.iface.focus.current).toBe(prompt(ctx.container));
    });

    test("switching back to the prompt's tab focuses the prompt", async () => {
        const ctx = setup();
        ctx.driver({ type: "configure", kind: "prompt", from: SHELL, label: "cq" });
        await settle();
        const { box } = run(ctx, { label: "sleep" }, { zone: "tab" });
        await settle();
        expect(ctx.iface.focus.current).toBe(box());

        ctx.iface.cycleTabs(true);
        await settle();
        expect(shown(prompt(ctx.container))).toBe(true);
        expect(ctx.iface.focus.current).toBe(prompt(ctx.container));
    });

    test("a background cell's new tab stays in the background", async () => {
        const ctx = setup();
        ctx.driver({ type: "configure", kind: "prompt", from: SHELL, label: "cq" });
        await settle();
        const { box } = run(ctx, { label: "sleep", background: true }, { zone: "tab" });
        await settle();
        expect(shown(box())).toBe(false);
        expect(ctx.iface.focus.current).toBe(prompt(ctx.container));
    });
});

describe("views of a process", () => {
    const proc = [...SHELL, "2"];

    function started() {
        const ctx = setup();
        ctx.driver({ type: "configure", kind: "prompt", from: SHELL, label: "cq" });
        ctx.driver({ type: "configure", from: proc, zone: "tab", label: "app" });
        const boxOf = (view: string) => ctx.iface.layout.boxOf(ctx.buche.get([...proc, view]));
        // A view is declared, then sent to (as coquille does).
        const stdout = () => {
            ctx.driver({ type: "configure", from: [...proc, "$stdout"], kind: "terminal" });
            ctx.driver({
                type: "send",
                from: [...proc, "$stdout"],
                message: { type: "text", stream: "stdout", text: "x" },
            });
        };
        const frame = () => {
            ctx.driver({ type: "configure", from: [...proc, "$frame"], kind: "frame" });
            ctx.driver({
                type: "send",
                from: [...proc, "$frame"],
                message: { type: "data", data: 1 },
            });
        };
        return { ...ctx, boxOf, stdout, frame };
    }

    test("a terminal coming after the frame is shown, and takes the focus", async () => {
        const ctx = started();
        ctx.frame();
        await settle();
        expect(ctx.iface.focus.current?.closest("echo-box")).toBe(ctx.boxOf("$frame"));
        ctx.stdout();
        await settle();
        const term = ctx.boxOf("$stdout");
        expect(shown(term)).toBe(true);
        expect(ctx.iface.focus.current).toBe(term);
    });

    test("a frame coming after the terminal is shown, and takes the focus", async () => {
        const ctx = started();
        ctx.stdout();
        await settle();
        ctx.iface.focus.focus(ctx.boxOf("$stdout")!, "api");
        ctx.frame();
        await settle();
        expect(shown(ctx.boxOf("$frame"))).toBe(true);
        expect(ctx.iface.focus.current?.closest("echo-box")).toBe(ctx.boxOf("$frame"));
    });

    test("the focus elsewhere stays there", async () => {
        const ctx = started();
        ctx.frame();
        await settle();
        const promptEl = prompt(ctx.container);
        ctx.iface.focus.focus(promptEl, "api");
        ctx.stdout();
        await settle();
        expect(shown(ctx.boxOf("$stdout"))).toBe(true);
        expect(ctx.iface.focus.current).toBe(promptEl);
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
        ctx.driver({ type: "configure", kind: "prompt", from: SHELL, label: "cq" });
        await settle();
        const { box } = run(ctx, { label: "sleep" }, { zone: "tab" });
        await settle();
        const entry = box()?.boundEntry;
        ctx.iface.interactions.purge();

        tabClose(ctx.container, "sleep")?.click();
        expect(withoutResizes(ctx.iface.interactions.purge())).toEqual([
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

    test("the focus stays in the tab group, even if it was elsewhere before", async () => {
        const ctx = setup();
        const { driver, iface, container } = ctx;
        driver({ type: "configure", kind: "prompt", from: SHELL, label: "cq" });
        driver({
            type: "configure",
            kind: "terminal",
            from: [...SHELL, "2"],
            zone: "logs",
            label: "far",
        });
        driver({
            type: "configure",
            kind: "terminal",
            from: [...SHELL, "3"],
            zone: "tab",
            label: "near",
        });
        await settle();
        const boxOf = (i: string) => iface.layout.boxOf(ctx.buche.get([...SHELL, i]))!;
        // Last in the other pane, then in the tab beside the prompt.
        iface.focus.focus(boxOf("2"), "nav");
        iface.focus.focus(boxOf("3"), "nav");
        await settle();

        tabClose(container, "near")?.click();
        driver({ type: "close", from: [...SHELL, "3"], outcome: { type: "error" } });
        await settle();
        await settle();
        expect(hasTab(container, "near")).toBe(false);
        expect(iface.focus.current).toBe(prompt(container));
    });

    test("a process saying it runs again refuses the close: the tab stays", async () => {
        const ctx = setup();
        ctx.driver({ type: "configure", kind: "prompt", from: SHELL, label: "cq" });
        await settle();
        const { box } = run(ctx, { label: "edit" }, { zone: "tab" });
        await settle();
        const ws = ctx.iface.layout.ws;
        const tabId = () =>
            ws
                .trees()
                .flatMap((t) => panesOf(t))
                .flatMap((p) => p.tabs)
                .find((t) => t.title === "edit")?.id;

        // Before the SIGTERM lands, it was already running: nothing cancelled.
        tabClose(ctx.container, "edit")?.click();
        ctx.driver({
            type: "send",
            from: [...SHELL, "2"],
            message: { type: "text", stream: "stdout", text: "x" },
        });
        await settle();
        expect(ws.isClosing(tabId()!)).toBe(true);
        ctx.flush(); // the SIGTERM: unresponsive
        await settle();
        expect(ws.isClosing(tabId()!)).toBe(true);

        ctx.driver({ type: "configure", from: [...SHELL, "2"], status: "running" });
        await settle();
        expect(hasTab(ctx.container, "edit")).toBe(true);
        expect(ws.isClosing(tabId()!)).toBe(false);
        expect(tabClose(ctx.container, "edit")).not.toBeNull();
        expect(box()).not.toBeNull();

        // Closing again: it can still go.
        tabClose(ctx.container, "edit")?.click();
        ctx.flush();
        ctx.driver({ type: "close", from: [...SHELL, "2"], outcome: { type: "success" } });
        await settle();
        await settle();
        expect(hasTab(ctx.container, "edit")).toBe(false);
    });

    test("Alt+Q Shift+W force closes a cell that refuses", async () => {
        const ctx = setup();
        ctx.driver({ type: "configure", kind: "prompt", from: SHELL, label: "cq" });
        await settle();
        const { box } = run(ctx, { label: "edit" }, { zone: "tab" });
        await settle();
        const entry = box()?.boundEntry;
        ctx.iface.interactions.purge();
        const key = (code: string, opts: KeyboardEventInit = {}) => {
            window.dispatchEvent(
                new KeyboardEvent("keydown", { code, key: code, bubbles: true, ...opts }),
            );
            window.dispatchEvent(
                new KeyboardEvent("keyup", { code, key: code, bubbles: true, ...opts }),
            );
        };
        window.dispatchEvent(
            new KeyboardEvent("keydown", { code: "AltLeft", key: "Alt", altKey: true }),
        );
        key("KeyQ", { altKey: true });
        key("KeyW", { altKey: true, shiftKey: true });
        window.dispatchEvent(new KeyboardEvent("keyup", { code: "AltLeft", key: "Alt" }));
        await settle();
        expect(hasTab(ctx.container, "edit")).toBe(false);
        expect([...ctx.iface.interactions.purge()]).toContainEqual({
            type: "user_signal",
            code: 9,
            entry,
        });
    });

    test("on an ended cell's tab, removes it right away", async () => {
        const ctx = setup();
        ctx.driver({ type: "configure", kind: "prompt", from: SHELL, label: "cq" });
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
        ctx.driver({ type: "configure", kind: "prompt", from: SHELL, label: "cq" });
        const proc = [...SHELL, "2"];
        ctx.driver({ type: "configure", from: proc, zone: "tab", label: "app" });
        ctx.driver({ type: "configure", from: [...proc, "$stdout"], kind: "terminal" });
        ctx.driver({
            type: "send",
            from: [...proc, "$stdout"],
            message: { type: "text", stream: "stdout", text: "x" },
        });
        ctx.driver({ type: "configure", from: [...proc, "$frame"], kind: "frame" });
        ctx.driver({
            type: "send",
            from: [...proc, "$frame"],
            message: { type: "data", data: 1 },
        });
        await settle();
        const tabs = () =>
            [...ctx.container.querySelectorAll(".carreau-tab")].filter(
                (t) => shown(t) && t.textContent?.startsWith("app"),
            );
        expect(tabs()).toHaveLength(2);
        ctx.iface.interactions.purge();
        const signalled = () => {
            ctx.flush();
            return ctx.sent.filter((m) => m.type === "signal").map((m) => m.to);
        };
        // The first tab: its view is signalled (nothing to coquille), and the
        // tab goes right away — the process goes on in the other.
        tabs()[1].querySelector<HTMLElement>(".carreau-tab-close")?.click();
        await settle();
        expect(signalled()).toEqual([[...proc, "$frame"]]);
        expect(tabs()).toHaveLength(1);
        // The last one: the process is signalled with it.
        tabs()[0].querySelector<HTMLElement>(".carreau-tab-close")?.click();
        expect(signalled().slice(1)).toEqual([[...proc, "$stdout"], proc]);
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
        driver({ type: "configure", kind: "prompt", from: SHELL, label: "cq" });
        const main = paneOf("cq");
        expect(main?.name).toBe("main");

        // `@left coquille`: the sub-shell's placeholder goes in a new pane on
        // the left, and its prompt takes its place there.
        const sub = [...SHELL, "1"];
        driver({ type: "configure", from: sub, zone: "@left", label: "coquille" });
        driver({ type: "configure", kind: "prompt", from: [...sub, "cq"], label: "sub" });
        const left = paneOf("sub");
        expect(left).not.toBeNull();
        expect(left).not.toBe(paneOf("cq"));
        expect(paneOf("coquille")).toBeNull();

        // From the sub-shell, `@r ls` goes back right, into the main pane.
        driver({
            type: "configure",
            kind: "terminal",
            from: [...sub, "cq", "2"],
            zone: "@r",
            label: "right",
        });
        expect(paneOf("right")).toBe(paneOf("cq"));
        // `@tab` beside its prompt, in its pane.
        driver({
            type: "configure",
            kind: "terminal",
            from: [...sub, "cq", "3"],
            zone: "tab",
            label: "tabbed",
        });
        expect(paneOf("tabbed")).toBe(paneOf("sub"));
        // Inline: in the sub-shell's stream.
        driver({
            type: "configure",
            kind: "terminal",
            from: [...sub, "cq", "4"],
            label: "plain",
        });
        expect(
            iface.layout.boxOf(ctx.buche.get([...sub, "cq", "4"]))?.closest(".carreau-scroll"),
        ).not.toBeNull();
        // Names: an existing pane, or a new one.
        driver({
            type: "configure",
            kind: "terminal",
            from: [...sub, "cq", "5"],
            zone: "main",
            label: "far",
        });
        expect(paneOf("far")).toBe(paneOf("cq"));
        driver({
            type: "configure",
            kind: "terminal",
            from: [...sub, "cq", "6"],
            zone: "logs",
            label: "logged",
        });
        expect(paneOf("logged")?.name).toBe("logs");
    });

    test("a merged shell ending: the focus stays in its linked group", async () => {
        const ctx = setup();
        const { driver, iface, container } = ctx;
        driver({ type: "configure", kind: "prompt", from: SHELL, label: "cq" });
        const sub = [...SHELL, "1"];
        driver({ type: "configure", from: sub, label: "coquille" });
        driver({ type: "configure", kind: "prompt", from: [...sub, "cq"], label: "sub" });
        driver({
            type: "configure",
            kind: "terminal",
            from: [...sub, "cq", "2"],
            zone: "tab",
            label: "ls",
        });
        await settle();
        const labels = () =>
            [...container.querySelectorAll(".carreau-tab")]
                .filter(shown)
                .map((t) => t.querySelector(".carreau-tab-short")?.textContent);
        expect(labels()).toEqual(["cq", "sub", "ls"]);
        // Back to the merged stream (its prompt takes the focus), typing as `sub`.
        [...container.querySelectorAll<HTMLElement>(".carreau-tab")]
            .find((t) => shown(t) && t.querySelector(".carreau-tab-short")?.textContent === "sub")
            ?.click();
        await settle();
        expect(iface.focus.current).toBe(prompt(container, "sub"));

        // Ctrl+D: the sub-shell ends.
        driver({ type: "close", from: sub, outcome: { type: "success" } });
        await settle();
        await settle();
        expect(labels()).toEqual(["cq", "ls"]);
        expect(iface.focus.current).toBe(prompt(container, "cq"));
        expect(shown(prompt(container, "cq"))).toBe(true);
    });

    test("a nested shell started inline gets a tab linked to its parent's", async () => {
        const ctx = setup();
        const { driver, iface } = ctx;
        driver({ type: "configure", kind: "prompt", from: SHELL, label: "cq" });
        const sub = [...SHELL, "1"];
        driver({ type: "configure", from: sub, label: "coquille" });
        driver({ type: "configure", kind: "prompt", from: [...sub, "cq"], label: "sub" });
        await settle();
        const tabs = [...ctx.container.querySelectorAll(".carreau-tab")].filter(shown);
        const labels = tabs.map((t) => t.querySelector(".carreau-tab-short")?.textContent);
        expect(labels).toEqual(["cq", "sub"]);
        expect(tabs.every((t) => t.classList.contains("linked"))).toBe(true);
        // The sub-shell's commands go in the merged stream.
        driver({
            type: "configure",
            kind: "terminal",
            from: [...sub, "cq", "2"],
            label: "ls",
        });
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
        driver({ type: "configure", kind: "prompt", from: SHELL, label: "cq" });
        driver({
            type: "configure",
            kind: "terminal",
            from: [...SHELL, "2"],
            label: "sleep",
        });
        const sub = [...SHELL, "3"];
        driver({ type: "configure", from: sub, label: "coquille" });
        driver({ type: "configure", kind: "prompt", from: [...sub, "cq"], label: "sub" });
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
        driver({ type: "configure", kind: "prompt", from: SHELL, label: "cq" });
        driver({ type: "configure", kind: "prompt", from: ["$proc", "other"], label: "other" });
        driver({
            type: "configure",
            kind: "terminal",
            from: [...SHELL, "2"],
            label: "sleep",
        });
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
        driver({ type: "configure", kind: "prompt", from: SHELL, label: "cq" });
        driver({
            type: "configure",
            kind: "terminal",
            from: [...SHELL, "2"],
            zone: "logs",
            label: "x",
        });
        driver({ type: "close", from: [...SHELL, "2"], outcome: { type: "success" } });
        const ws = iface.layout.ws;
        await ws.closeTab(ws.paneByName("logs")!.tabs[0].id);
        await settle();
        const chooser = container.querySelector("slot-chooser")!;
        expect(shown(chooser)).toBe(true);
        iface.focus.focus(prompt(container));
        iface.interactions.purge();

        pick(chooser, "4");
        const [command] = withoutResizes(iface.interactions.purge()) as any[];
        const zone = `~${ws.paneByName("logs")!.id}`;
        expect(command).toMatchObject({ type: "user_command", text: "cq", command: "run", zone });
        // The shell's placeholder, then its prompt, go into the pane.
        const sub = [...SHELL, "3"];
        driver({ type: "configure", from: sub, zone, label: "cq" });
        driver({ type: "configure", kind: "prompt", from: [...sub, "cq"], label: "sub" });
        expect(ws.paneByName("logs")!.tabs.map((t) => t.title)).toEqual(["sub"]);
    });

    test("Alt+Q W closes an empty named pane", async () => {
        const ctx = setup();
        const { driver, iface, container } = ctx;
        driver({ type: "configure", kind: "prompt", from: SHELL, label: "cq" });
        driver({
            type: "configure",
            kind: "terminal",
            from: [...SHELL, "2"],
            zone: "logs",
            label: "x",
        });
        driver({ type: "close", from: [...SHELL, "2"], outcome: { type: "success" } });
        const ws = iface.layout.ws;
        await ws.closeTab(ws.paneByName("logs")!.tabs[0].id);
        await settle();
        expect(ws.paneByName("logs")?.tabs).toEqual([]);
        ws.select({ id: ws.paneByName("logs")!.id });
        const press = (type: string, key: string, code: string, altKey = true) =>
            container.dispatchEvent(new KeyboardEvent(type, { key, code, altKey, bubbles: true }));
        press("keydown", "Alt", "AltLeft");
        for (const code of ["KeyQ", "KeyW"]) {
            const key = code.slice(3).toLowerCase();
            press("keydown", key, code);
            press("keyup", key, code);
        }
        press("keyup", "Alt", "AltLeft", false);
        await settle();
        expect(ws.paneByName("logs")).toBeNull();
    });

    test("insert offers a new scroll column, named at random, empty, which stays", async () => {
        const ctx = setup();
        const { driver, iface, container } = ctx;
        driver({ type: "configure", kind: "prompt", from: SHELL, label: "cq" });
        const ws = iface.layout.ws;
        ws.select({ id: iface.layout.promptNodeOf(ctx.buche.get(SHELL))! });
        iface.layout.insert();
        await settle();
        const chooser = [...container.querySelectorAll("slot-chooser")].find(shown)!;
        pick(chooser, "2");
        await settle();
        // (Its name is then edited in its tab: see View.editTabTitle.)
        const named = (t: { title: string }) => /^[a-z]+-[a-z]+$/.test(t.title);
        const tab = ws.root.type === "pane" ? ws.root.tabs.find(named) : undefined;
        const stream = tab?.group?.children[0];
        expect(stream?.type).toBe("scroll-column");
        expect(stream && "children" in stream && stream.children).toEqual([]);
        expect([...container.querySelectorAll("slot-chooser")].filter(shown)).toHaveLength(0);
    });

    test("insert offers a new pane: a kept empty pane in a group, offering a slot", async () => {
        const ctx = setup();
        const { driver, iface, container } = ctx;
        driver({ type: "configure", kind: "prompt", from: SHELL, label: "cq" });
        const ws = iface.layout.ws;
        ws.select({ id: iface.layout.promptNodeOf(ctx.buche.get(SHELL))! });
        iface.layout.insert();
        await settle();
        const chooser = [...container.querySelectorAll("slot-chooser")].find(shown)!;
        pick(chooser, "1");
        await settle();
        const named = (t: { title: string }) => /^[a-z]+-[a-z]+$/.test(t.title);
        // (Found after the normalization that ran on the change: kept, empty, it stays.)
        const tab = ws.root.type === "pane" ? ws.root.tabs.find(named) : undefined;
        const root = tab?.group?.children[0];
        expect(root?.type).toBe("pane");
        expect(root && "tabs" in root && root.tabs).toEqual([]);
        expect(root && "keep" in root && root.keep).toBe(true);
        // (The empty pane is no dead space: it offers what can go in it.)
        expect([...container.querySelectorAll("slot-chooser")].filter(shown)).toHaveLength(1);
    });

    test("Alt+Q I F offers a slot in a new floating window", async () => {
        const ctx = setup();
        const { driver, iface, container } = ctx;
        driver({ type: "configure", kind: "prompt", from: SHELL, label: "cq" });
        const ws = iface.layout.ws;
        ws.select({ id: iface.layout.promptNodeOf(ctx.buche.get(SHELL))! });
        const press = (type: string, key: string, code: string, altKey = true) =>
            container.dispatchEvent(new KeyboardEvent(type, { key, code, altKey, bubbles: true }));
        press("keydown", "Alt", "AltLeft");
        for (const code of ["KeyQ", "KeyI", "KeyF"]) {
            const key = code.slice(3).toLowerCase();
            press("keydown", key, code);
            press("keyup", key, code);
        }
        press("keyup", "Alt", "AltLeft", false);
        await settle();
        expect(ws.floating).toHaveLength(1);
        const [win] = ws.floating;
        expect(win.root.type === "pane" && win.root.tabs).toHaveLength(1);
        expect([...container.querySelectorAll("slot-chooser")].filter(shown)).toHaveLength(1);
    });

    test("typing in a slot runs a command there, from the last prompt", async () => {
        const ctx = setup();
        const { driver, iface, container } = ctx;
        driver({ type: "configure", kind: "prompt", from: SHELL, label: "cq" });
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
        const [command] = withoutResizes(iface.interactions.purge()) as any[];
        expect(command).toMatchObject({ type: "user_command", text: "ls", command: "run" });
        expect(command.zone).toMatch(/^~/);
    });

    test("with no prompt, the shell is one of its own", async () => {
        const ctx = setup();
        const { iface, container } = ctx;
        await settle();
        const chooser = [...container.querySelectorAll("slot-chooser")].find(shown)!;
        pick(chooser, "4");
        const [spawn] = [...iface.interactions.purge()] as any[];
        expect(spawn).toMatchObject({ type: "user_spawn", command: "cq" });
        // The machine starts it at an address of its own, its prompt going there.
        const sent: any[] = [];
        ctx.buche.sendDriver = (m) => sent.push(m);
        ctx.buche.handle(spawn);
        expect(sent).toEqual([{ type: "spawn", from: ["$term"], to: ["$d1"], command: "cq" }]);
        ctx.driver({
            type: "configure",
            kind: "prompt",
            from: ["$d1", "$proc", "cq"],
            label: "cq",
        });
        expect(iface.layout.ws.paneByName("main")!.tabs.map((t) => t.title)).toEqual(["cq"]);
    });
});

describe("@pop", () => {
    // A command from the prompt, answered by a cell at `from` in the pop.
    function pop(ctx: ReturnType<typeof setup>, n: string, echo: Record<string, unknown> = {}) {
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
        const from = [...SHELL, n];
        ctx.driver({
            type: "configure",
            kind: "terminal",
            from,
            zone: "@pop",
            id,
            label: `pop${n}`,
            ...echo,
        });
        const box = () => ctx.container.querySelector<EchoBox>(`#echo-${id}`);
        return { from, box, entry: () => box()?.boundEntry };
    }

    async function started() {
        const ctx = setup();
        ctx.driver({ type: "configure", kind: "prompt", from: SHELL, label: "cq" });
        await settle();
        return ctx;
    }

    test("a cell goes in a floating window of its own, and takes the focus", async () => {
        const ctx = await started();
        const { box } = pop(ctx, "2");
        await settle();
        const ws = ctx.iface.layout.ws;
        expect(ws.floating).toHaveLength(1);
        const [win] = ws.floating;
        const cell = box();
        expect(shown(cell)).toBe(true);
        expect(
            ctx.container.querySelector(`[data-id="${panesOf(win.root)[0].id}"]`)?.contains(cell!),
        ).toBe(true);
        expect(ctx.iface.focus.current).toBe(cell);
        // No chrome; as tall as the cell (which doesn't fill it).
        expect(win).toMatchObject({ bare: true, fit: true });
        const winEl = cell!.closest(".carreau-float")!;
        expect(winEl.classList.contains("carreau-float-bare")).toBe(true);
        expect(winEl.querySelector(".carreau-float-bar, .carreau-float-resize")).toBeNull();
        expect(cell!.hasAttribute("fills")).toBe(false);
    });

    test("the focus leaving it terminates it, and the window goes right away", async () => {
        const ctx = await started();
        const { box, entry } = pop(ctx, "2");
        await settle();
        const e = entry();
        ctx.iface.interactions.purge();

        ctx.iface.focus.focus(prompt(ctx.container), "click");
        expect(withoutResizes(ctx.iface.interactions.purge())).toEqual([
            { type: "user_signal", code: 15, entry: e },
        ]);
        expect(ctx.iface.layout.ws.floating).toHaveLength(0);
        expect(box()).toBeNull();
    });

    test("ended, it keeps the focus; Esc goes back to the prompt and closes it", async () => {
        const ctx = await started();
        const { box, from } = pop(ctx, "2");
        await settle();
        ctx.driver({ type: "close", from, outcome: { type: "success" } });
        await settle();
        expect(ctx.iface.focus.current).toBe(box());
        ctx.iface.interactions.purge();

        box()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await settle();
        expect(ctx.iface.focus.current).toBe(prompt(ctx.container));
        expect(ctx.iface.layout.ws.floating).toHaveLength(0);
        // (Nothing left to signal.)
        expect(
            [...ctx.iface.interactions.purge()].filter((m) => m.type === "user_signal"),
        ).toEqual([]);
    });

    test("Esc while it runs is the app's", async () => {
        const ctx = await started();
        const { box } = pop(ctx, "2");
        await settle();
        box()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await settle();
        expect(ctx.iface.focus.current).toBe(box());
        expect(ctx.iface.layout.ws.floating).toHaveLength(1);
    });

    test("a new pop closes the previous one", async () => {
        const ctx = await started();
        const first = pop(ctx, "2");
        await settle();
        const e = first.entry();
        ctx.iface.interactions.purge();

        const second = pop(ctx, "3");
        await settle();
        expect(first.box()).toBeNull();
        expect(ctx.iface.layout.ws.floating).toHaveLength(1);
        expect(ctx.iface.focus.current).toBe(second.box());
        expect([...ctx.iface.interactions.purge()]).toContainEqual({
            type: "user_signal",
            code: 15,
            entry: e,
        });
    });
});
