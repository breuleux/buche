// @vitest-environment happy-dom

import { afterEach, describe, expect, test } from "vitest";
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
    function drag(box: EchoBox, fromY: number, toY: number): void {
        const gutter = q(box, ".echo-box-gutter") as HTMLElement;
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

    test("dragging the gutter up grows the cell, down shrinks it", () => {
        const box = make();
        const cell = q(box, ".echo-box-cell") as HTMLElement;
        // Drag up by 40px from a 0-height baseline → +40px.
        drag(box, 100, 60);
        expect(cell.style.height).toBe("40px");
        // Drag down 20px from that height → 20px.
        drag(box, 60, 80);
        expect(cell.style.height).toBe("20px");
        // Never goes below 0.
        drag(box, 80, 300);
        expect(cell.style.height).toBe("0px");
    });

    test("the reverse attribute swaps the drag directions", () => {
        const box = make({ reverse: "" });
        const cell = q(box, ".echo-box-cell") as HTMLElement;
        // With reverse, dragging down grows the cell.
        drag(box, 100, 140);
        expect(cell.style.height).toBe("40px");
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
