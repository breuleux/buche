// @vitest-environment happy-dom

import { afterEach, describe, expect, test } from "vitest";
import { styleToCss, defaultTheme as th } from "../../src/color.ts";
import type { EchoBox } from "../../src/components/echo-box.tsx";
import "../../src/components/echo-box.tsx";

afterEach(() => {
    document.body.replaceChildren();
});

function make(attrs: Record<string, string> = {}): EchoBox {
    const el = document.createElement("echo-box") as EchoBox;
    for (const [k, v] of Object.entries(attrs)) {
        el.setAttribute(k, v);
    }
    document.body.append(el);
    return el;
}

const q = (el: EchoBox, sel: string) => el.querySelector(sel);

describe("echo-box — structure", () => {
    test("builds a gutter with a status circle, an echo, controls and a cell", () => {
        const box = make();
        expect(q(box, ".echo-box-gutter")).not.toBeNull();
        expect(q(box, ".echo-box-gutter .echo-box-status")).not.toBeNull();
        expect(q(box, ".echo-box-echo")).not.toBeNull();
        expect(q(box, ".echo-box-cell")).not.toBeNull();
        expect(q(box, ".echo-box-controls .echo-box-close")).not.toBeNull();
    });
});

describe("echo-box — echo text", () => {
    test("reads the echo attribute", () => {
        const box = make({ echo: "ls -la" });
        expect(q(box, ".echo-box-echo")?.textContent).toBe("ls -la");
        expect(box.echo).toBe("ls -la");
    });

    test("the echo property updates the text", () => {
        const box = make();
        box.echo = "make build";
        expect(q(box, ".echo-box-echo")?.textContent).toBe("make build");
    });

    test("setEcho accepts a rich node", () => {
        const box = make();
        const span = document.createElement("span");
        span.textContent = "cmd";
        box.setEcho(span);
        expect(q(box, ".echo-box-echo")?.firstElementChild).toBe(span);
    });

    test("setEcho accepts a StyledText and renders colorized spans", () => {
        const box = make();
        box.setEcho({
            text: "git commit",
            ranges: [
                { start: 0, end: 3, style: "green bold" },
                { start: 4, end: 10, style: "blue" },
            ],
        });

        const echoEl = q(box, ".echo-box-echo")!;
        // The whole command reads back as text…
        expect(echoEl.textContent).toBe("git commit");
        // …built from a .styled-text container with one span per range.
        const container = echoEl.querySelector(".styled-text")!;
        const spans = container.querySelectorAll("span");
        expect(spans.length).toBe(2);
        expect(spans[0].textContent).toBe("git");
        expect(spans[0].getAttribute("style")).toBe(styleToCss(th.calculateStyle("green bold")));
        expect(spans[1].textContent).toBe("commit");
        expect(box.echo).toBe("git commit");
    });

    test("the echo property accepts a StyledText too", () => {
        const box = make();
        box.echo = { text: "ok", ranges: [{ start: 0, end: 2, style: "green" }] };
        expect(q(box, ".echo-box-echo .styled-text")).not.toBeNull();
        expect(box.echo).toBe("ok");
    });
});

describe("echo-box — colour", () => {
    test("the color attribute sets --echo-color", () => {
        const box = make({ color: "#8ae234" });
        expect(box.style.getPropertyValue("--echo-color")).toBe("#8ae234");
        expect(box.color).toBe("#8ae234");
    });

    test("the color property updates --echo-color", () => {
        const box = make();
        box.color = "#f44";
        expect(box.style.getPropertyValue("--echo-color")).toBe("#f44");
    });

    test("a colour accent is parsed through the theme", () => {
        const box = make({ color: "green" });
        expect(box.style.getPropertyValue("--echo-color")).toBe(th.calculateColor("green"));

        box.color = "blue L80";
        expect(box.style.getPropertyValue("--echo-color")).toBe(th.calculateColor("blue L80"));
    });

    test("an unparseable value (a plain CSS colour) is used verbatim", () => {
        const box = make();
        box.color = "rebeccapurple";
        expect(box.style.getPropertyValue("--echo-color")).toBe("rebeccapurple");
    });
});

describe("echo-box — status", () => {
    test("defaults to running and labels the closing icon 'Kill'", () => {
        const box = make();
        expect(box.status).toBe("running");
        expect(box.getAttribute("data-status")).toBe("running");
        expect(q(box, ".echo-box-close")?.getAttribute("title")).toBe("Kill");
    });

    test("setting status reflects to data-status and relabels the closing icon", () => {
        const box = make();
        box.status = "done";
        expect(box.getAttribute("data-status")).toBe("done");
        expect(q(box, ".echo-box-close")?.getAttribute("title")).toBe("Close");

        box.status = "error";
        expect(box.getAttribute("data-status")).toBe("error");
    });

    test("reacts to the status attribute changing", () => {
        const box = make({ status: "done" });
        expect(box.status).toBe("done");
        box.setAttribute("status", "error");
        expect(box.getAttribute("data-status")).toBe("error");
    });
});

describe("echo-box — views", () => {
    test("addView creates an icon and content container; the first is active", () => {
        const box = make();
        const out = box.addView({ id: "stdout", icon: "▤", label: "Output" });
        expect(out.getAttribute("data-view")).toBe("stdout");
        expect(out.hidden).toBe(false); // first view is shown
        expect(box.activeView).toBe("stdout");
        const btn = q(box, '.echo-box-view-btn[data-view="stdout"]');
        expect(btn?.textContent).toBe("▤");
        expect(btn?.getAttribute("title")).toBe("Output");
        // A single view: nothing to switch, icons are hidden via CSS class.
        expect(q(box, ".echo-box-controls")?.classList.contains("single-view")).toBe(true);
    });

    test("a second view hides the others and drops the single-view state", () => {
        const box = make();
        box.addView({ id: "stdout" });
        const gui = box.addView({ id: "gui" });
        expect(gui.hidden).toBe(true); // stdout still active
        expect(box.views).toEqual(["stdout", "gui"]);
        expect(q(box, ".echo-box-controls")?.classList.contains("single-view")).toBe(false);
    });

    test("showView switches the visible view and fires viewchange", () => {
        const box = make();
        box.addView({ id: "stdout" });
        box.addView({ id: "gui" });
        const events: string[] = [];
        box.addEventListener("viewchange", (e) => {
            events.push((e as CustomEvent<{ view: string }>).detail.view);
        });

        box.showView("gui");
        expect(box.activeView).toBe("gui");
        expect(box.getView("stdout")?.hidden).toBe(true);
        expect(box.getView("gui")?.hidden).toBe(false);
        expect(q(box, '.echo-box-view-btn[data-view="gui"]')?.classList.contains("active")).toBe(
            true,
        );
        expect(events).toEqual(["gui"]);
    });

    test("clicking a view icon switches to it", () => {
        const box = make();
        box.addView({ id: "stdout" });
        box.addView({ id: "gui" });
        q(box, '.echo-box-view-btn[data-view="gui"]')?.dispatchEvent(
            new MouseEvent("click", { bubbles: true }),
        );
        expect(box.activeView).toBe("gui");
    });

    test("removeView drops it and activates the next", () => {
        const box = make();
        box.addView({ id: "stdout" });
        box.addView({ id: "gui" });
        box.removeView("stdout");
        expect(box.views).toEqual(["gui"]);
        expect(box.activeView).toBe("gui");
        expect(q(box, '.echo-box-view-btn[data-view="stdout"]')).toBeNull();
    });

    test("addView on an existing id replaces its content", () => {
        const box = make();
        const a = document.createElement("p");
        box.addView({ id: "stdout", content: a });
        const b = document.createElement("p");
        box.addView({ id: "stdout", content: b });
        expect(box.getView("stdout")?.children.length).toBe(1);
        expect(box.getView("stdout")?.firstElementChild).toBe(b);
    });
});

describe("echo-box — resize handle", () => {
    // The bar spans y ∈ [0, 200] (stubbed), so its middle is at y = 100:
    // y < 100 is the top half, y ≥ 100 the bottom half.
    const BAR_HEIGHT = 200;

    // Prepare a box whose cell starts at `startHeight` and whose gutter reports a
    // fixed on-screen rect (happy-dom otherwise returns an all-zero rect).
    function setup(startHeight: number, attrs: Record<string, string> = {}) {
        const box = make(attrs);
        const cell = q(box, ".echo-box-cell") as HTMLElement;
        cell.style.height = `${startHeight}px`;
        const gutter = q(box, ".echo-box-gutter") as HTMLElement;
        gutter.getBoundingClientRect = () =>
            ({ top: 0, bottom: BAR_HEIGHT, height: BAR_HEIGHT }) as DOMRect;
        return { box, cell, gutter };
    }

    function drag(gutter: HTMLElement, fromY: number, toY: number): void {
        gutter.dispatchEvent(
            new PointerEvent("pointerdown", {
                clientY: fromY,
                button: 0,
                pointerId: 1,
                bubbles: true,
            }),
        );
        gutter.dispatchEvent(
            new PointerEvent("pointermove", { clientY: toY, pointerId: 1, bubbles: true }),
        );
        gutter.dispatchEvent(
            new PointerEvent("pointerup", { clientY: toY, pointerId: 1, bubbles: true }),
        );
    }

    test("top half: up grows, down shrinks", () => {
        const { cell, gutter } = setup(100);
        drag(gutter, 50, 30); // top half, drag up 20 → grow
        expect(cell.style.height).toBe("120px");
        cell.style.height = "100px";
        drag(gutter, 50, 70); // top half, drag down 20 → shrink
        expect(cell.style.height).toBe("80px");
    });

    test("bottom half: down grows, up shrinks", () => {
        const { cell, gutter } = setup(100);
        drag(gutter, 150, 170); // bottom half, drag down 20 → grow
        expect(cell.style.height).toBe("120px");
        cell.style.height = "100px";
        drag(gutter, 150, 130); // bottom half, drag up 20 → shrink
        expect(cell.style.height).toBe("80px");
    });

    test("the top line (header row) always counts as the top half", () => {
        const { cell, gutter } = setup(100);
        // A short bar: geometric middle at y=20, but the header runs down to y=30.
        gutter.getBoundingClientRect = () => ({ top: 0, bottom: 40, height: 40 }) as DOMRect;
        cell.getBoundingClientRect = () => ({ top: 30, bottom: 40, height: 10 }) as DOMRect;
        // Press at y=25: below the geometric middle, but on the header → top half.
        drag(gutter, 25, 5); // drag up 20 → grows (top-half behaviour)
        expect(cell.style.height).toBe("120px");
    });

    test("never shrinks below zero", () => {
        const { cell, gutter } = setup(10);
        drag(gutter, 50, 300); // top half, drag far down → clamped at 0
        expect(cell.style.height).toBe("0px");
    });

    test("the reverse attribute swaps grow and shrink", () => {
        const { cell, gutter } = setup(100, { reverse: "" });
        drag(gutter, 50, 30); // top half up would normally grow; reversed → shrink
        expect(cell.style.height).toBe("80px");
    });

    const stubScrollParent = (box: EchoBox, scroller: HTMLElement) => {
        (box as unknown as { resolveScrollParent: () => HTMLElement }).resolveScrollParent = () =>
            scroller;
    };

    // Attach a fake scroll container so anchoring is observable in happy-dom, and
    // simulate a normal top-pinned container: the top edge stays put while the
    // bottom edge tracks the cell's height (happy-dom does no layout of its own).
    function withScroller(box: EchoBox, scrollTop: number): HTMLElement {
        const scroller = document.createElement("div");
        scroller.scrollTop = scrollTop;
        stubScrollParent(box, scroller);
        const cell = q(box, ".echo-box-cell") as HTMLElement;
        box.getBoundingClientRect = () => {
            const h = Number.parseFloat(cell.style.height) || 0;
            return { top: 0, bottom: h, height: h } as DOMRect;
        };
        return scroller;
    }

    test("top-half drag scrolls to keep the bottom edge fixed", () => {
        const { box, cell, gutter } = setup(100);
        const scroller = withScroller(box, 500);
        drag(gutter, 50, 10); // top half, grow by 40
        expect(cell.style.height).toBe("140px");
        // Scroll absorbs the +40 growth so the bottom stays put.
        expect(scroller.scrollTop).toBe(540);
    });

    test("top-half shrink scrolls back the other way", () => {
        const { box, cell, gutter } = setup(100);
        const scroller = withScroller(box, 500);
        drag(gutter, 50, 70); // top half, shrink by 20
        expect(cell.style.height).toBe("80px");
        expect(scroller.scrollTop).toBe(480);
    });

    test("bottom-half drag leaves the scroll position untouched", () => {
        const { box, cell, gutter } = setup(100);
        const scroller = withScroller(box, 500);
        drag(gutter, 150, 170); // bottom half, grow by 20
        expect(cell.style.height).toBe("120px");
        expect(scroller.scrollTop).toBe(500);
    });

    test("bottom-pinned container: growth is not double-applied", () => {
        const { box, cell, gutter } = setup(100);
        const scroller = document.createElement("div");
        scroller.scrollTop = 0; // column-reverse reports 0 at the bottom
        stubScrollParent(box, scroller);
        // A <scroll-fader> already pins the bottom, so the element's bottom edge
        // does not move as the cell grows — the measured drift stays zero.
        box.getBoundingClientRect = () => ({ top: 0, bottom: 300, height: 300 }) as DOMRect;
        drag(gutter, 50, 10); // top half, grow by 40
        expect(cell.style.height).toBe("140px");
        expect(scroller.scrollTop).toBe(0); // no extra scroll layered on top
    });
});

describe("echo-box — closing", () => {
    test("clicking the closing icon dispatches a bubbling 'close' event", () => {
        const box = make();
        let fired = 0;
        box.addEventListener("close", () => {
            fired++;
        });
        q(box, ".echo-box-close")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        expect(fired).toBe(1);
    });
});

describe("echo-box — compact mode", () => {
    function drag(el: HTMLElement, fromY: number, toY: number): void {
        el.dispatchEvent(
            new PointerEvent("pointerdown", {
                clientY: fromY,
                button: 0,
                pointerId: 1,
                bubbles: true,
            }),
        );
        el.dispatchEvent(
            new PointerEvent("pointermove", { clientY: toY, pointerId: 1, bubbles: true }),
        );
        el.dispatchEvent(
            new PointerEvent("pointerup", { clientY: toY, pointerId: 1, bubbles: true }),
        );
    }

    test("setCompact toggles the compact attribute and property", () => {
        const box = make();
        expect(box.compact).toBe(false);
        box.setCompact(true);
        expect(box.compact).toBe(true);
        expect(box.hasAttribute("compact")).toBe(true);
        box.setCompact(false);
        expect(box.compact).toBe(false);
        expect(box.hasAttribute("compact")).toBe(false);
    });

    test("the compact attribute drives the property", () => {
        const box = make({ compact: "" });
        expect(box.compact).toBe(true);
        box.removeAttribute("compact");
        expect(box.compact).toBe(false);
    });

    test("puts an inline status dot to the left of the echo, plus resize handles", () => {
        const box = make();
        const header = q(box, ".echo-box-header") as HTMLElement;
        const status = q(box, ".echo-box-status-inline") as HTMLElement;
        // The inline status is a header child sitting before the echo.
        expect(status.parentElement).toBe(header);
        const kids = Array.from(header.children);
        expect(kids.indexOf(status)).toBeLessThan(
            kids.indexOf(q(box, ".echo-box-echo") as Element),
        );
        expect(q(box, ".echo-box-handle-top")).not.toBeNull();
        expect(q(box, ".echo-box-handle-bottom")).not.toBeNull();
    });

    test("Alt reveals the overlay only while hovering the box (not global)", () => {
        const box = make();
        box.setCompact(true);
        // Alt without the pointer over the box does nothing.
        window.dispatchEvent(new KeyboardEvent("keydown", { altKey: true }));
        expect(box.hasAttribute("data-alt")).toBe(false);
        // Pointer over the box + Alt → revealed.
        box.dispatchEvent(new PointerEvent("pointerenter", { altKey: true, bubbles: true }));
        expect(box.hasAttribute("data-alt")).toBe(true);
        // Releasing Alt hides it again.
        window.dispatchEvent(new KeyboardEvent("keyup", { altKey: false }));
        expect(box.hasAttribute("data-alt")).toBe(false);
        // Pressing Alt again while still hovering re-reveals it.
        window.dispatchEvent(new KeyboardEvent("keydown", { altKey: true }));
        expect(box.hasAttribute("data-alt")).toBe(true);
        // Leaving the box hides it and stops tracking.
        box.dispatchEvent(new PointerEvent("pointerleave", { bubbles: true }));
        expect(box.hasAttribute("data-alt")).toBe(false);
        window.dispatchEvent(new KeyboardEvent("keydown", { altKey: true }));
        expect(box.hasAttribute("data-alt")).toBe(false);
    });

    test("top handle grows on drag up; bottom handle grows on drag down", () => {
        const box = make();
        box.setCompact(true);
        const cell = q(box, ".echo-box-cell") as HTMLElement;
        cell.style.height = "100px";
        drag(q(box, ".echo-box-handle-top") as HTMLElement, 50, 30); // up 20 → grow
        expect(cell.style.height).toBe("120px");
        cell.style.height = "100px";
        drag(q(box, ".echo-box-handle-bottom") as HTMLElement, 50, 70); // down 20 → grow
        expect(cell.style.height).toBe("120px");
    });
});

describe("echo-box — authored views", () => {
    test("adopts authored [data-view] children as views", () => {
        const box = document.createElement("echo-box") as EchoBox;
        const stdout = document.createElement("div");
        stdout.setAttribute("data-view", "stdout");
        stdout.setAttribute("data-icon", "▤");
        stdout.setAttribute("data-label", "Output");
        stdout.textContent = "hello";
        const gui = document.createElement("div");
        gui.setAttribute("data-view", "gui");
        gui.setAttribute("data-icon", "◧");
        box.append(stdout, gui);
        document.body.append(box);

        expect(box.views).toEqual(["stdout", "gui"]);
        expect(box.activeView).toBe("stdout");
        expect(box.getView("stdout")?.textContent).toBe("hello");
        expect(q(box, '.echo-box-view-btn[data-view="gui"]')?.textContent).toBe("◧");
    });
});
