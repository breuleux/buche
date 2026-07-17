// @vitest-environment happy-dom

import { afterEach, describe, expect, test } from "vitest";
import { FocusManager } from "../src/focus.ts";

const managers: FocusManager[] = [];

afterEach(() => {
    for (const fm of managers.splice(0)) {
        fm.dispose();
    }
    document.body.replaceChildren();
});

function setup(): [FocusManager, HTMLElement] {
    const root = document.createElement("div");
    document.body.append(root);
    const fm = new FocusManager(root);
    managers.push(fm);
    return [fm, root];
}

function cell(id?: string): HTMLElement {
    const el = document.createElement("div");
    el.setAttribute("focusable", "cell");
    el.tabIndex = -1;
    if (id) {
        el.id = id;
    }
    return el;
}

// Let the MutationObserver deliver, then the microtasks it schedules run.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("FocusManager.expect", () => {
    test("focuses the element when it enters the DOM, tagged 'auto'", async () => {
        const [fm, root] = setup();
        fm.expect("out");
        expect(fm.expecting).toBe("out");

        root.append(cell(), cell("out"));
        await settle();
        expect(fm.current?.id).toBe("out");
        expect(fm.currentTags).toEqual(["cell", "auto"]);
        expect(fm.expecting).toBeNull();
    });

    test("focuses an element that is already there right away", () => {
        const [fm, root] = setup();
        root.append(cell("out"));
        fm.expect("out");
        expect(fm.current?.id).toBe("out");
    });

    test("is cancelled when the focus moves first", async () => {
        const [fm, root] = setup();
        const other = cell();
        root.append(other);
        fm.expect("out");
        fm.focus(other);
        expect(fm.expecting).toBeNull();

        root.append(cell("out"));
        await settle();
        expect(fm.current).toBe(other);
    });

    test("is not cancelled by a restore after the focused element is removed", async () => {
        const [fm, root] = setup();
        const a = cell();
        const b = cell();
        root.append(a, b);
        fm.focus(a);
        fm.focus(b);
        fm.expect("out");

        b.remove();
        await settle();
        expect(fm.current).toBe(a);
        expect(fm.expecting).toBe("out");

        root.append(cell("out"));
        await settle();
        expect(fm.current?.id).toBe("out");
    });

    test("waits for a hidden element to become visible", async () => {
        const [fm, root] = setup();
        const out = cell("out");
        out.style.display = "none";
        fm.expect("out");
        root.append(out);
        await settle();
        expect(fm.current).toBeNull();

        out.style.display = "";
        await settle();
        expect(fm.current).toBe(out);
    });

    test("catches an id given after insertion", async () => {
        const [fm, root] = setup();
        const out = cell();
        root.append(out);
        fm.expect("out");
        await settle();
        expect(fm.current).toBeNull();

        out.id = "out";
        await settle();
        expect(fm.current).toBe(out);
    });

    test("commits the focus, unless commits are held", async () => {
        const [fm, root] = setup();
        let commits = 0;
        const make = (id: string) =>
            Object.assign(cell(id), {
                commitFocus: () => {
                    commits++;
                },
            });

        fm.expect("one");
        root.append(make("one"));
        await settle();
        expect(commits).toBe(1);

        fm.holdCommits = true;
        fm.expect("two");
        root.append(make("two"));
        await settle();
        expect(fm.current?.id).toBe("two");
        expect(commits).toBe(1);
    });

    test("expect(null) cancels", async () => {
        const [fm, root] = setup();
        fm.expect("out");
        fm.expect(null);
        root.append(cell("out"));
        await settle();
        expect(fm.current).toBeNull();
    });
});

describe("focus-commit-request", () => {
    function committable(): HTMLElement & { commits: number } {
        const el = Object.assign(cell(), { commits: 0 });
        Object.assign(el, {
            commitFocus: () => {
                el.commits++;
            },
        });
        return el;
    }

    const request = (el: Element) =>
        el.dispatchEvent(new Event("focus-commit-request", { bubbles: true }));

    test("commits when it comes from inside the focused element", async () => {
        const [fm, root] = setup();
        const el = committable();
        const inner = document.createElement("span");
        el.append(inner);
        root.append(el);
        fm.focus(el);
        el.commits = 0;

        request(inner);
        await settle();
        expect(el.commits).toBe(1);
    });

    test("is ignored from elsewhere, or while commits are held", async () => {
        const [fm, root] = setup();
        const el = committable();
        const other = committable();
        root.append(el, other);
        fm.focus(el);
        el.commits = 0;

        request(other);
        await settle();
        expect(el.commits + other.commits).toBe(0);

        fm.holdCommits = true;
        request(el);
        await settle();
        expect(el.commits).toBe(0);
    });
});
