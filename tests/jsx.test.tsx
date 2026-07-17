// @vitest-environment happy-dom

import { afterEach, describe, expect, test } from "vitest";
import { Fragment, jsx } from "../src/jsx/jsx-runtime.ts";

// Vitest's happy-dom environment is created once per file, so reset the shared
// document between tests to keep them isolated.
afterEach(() => {
    document.body.replaceChildren();
});

// A function component, to check that `<Foo/>` calls it.
function Badge({ label }: { label: string }) {
    return <span className="badge">{label}</span>;
}

describe("jsx dom runtime", () => {
    test("document is isolated: mount into body", () => {
        expect(document.body.childNodes.length).toBe(0);
        document.body.append(<div id="mounted">x</div>);
        expect(document.body.childNodes.length).toBe(1);
    });

    test("document is isolated: body is empty again", () => {
        // Would be 1 if the previous test's mount leaked into this one.
        expect(document.body.childNodes.length).toBe(0);
    });

    test("intrinsic element with attributes and text", () => {
        const el = (<div id="root">hello</div>) as HTMLElement;
        expect(el.tagName).toBe("DIV");
        expect(el.id).toBe("root");
        expect(el.textContent).toBe("hello");
    });

    test("nested children and numbers", () => {
        const el = (
            <ul>
                <li>a</li>
                <li>{2}</li>
            </ul>
        ) as HTMLElement;
        expect(el.querySelectorAll("li")).toHaveLength(2);
        expect(el.textContent).toBe("a2");
    });

    test("event handlers are attached", () => {
        let clicks = 0;
        const el = (
            <button type="button" onclick={() => clicks++}>
                go
            </button>
        ) as HTMLElement;
        el.dispatchEvent(new Event("click"));
        expect(clicks).toBe(1);
    });

    test("function components render", () => {
        const el = (<Badge label="new" />) as HTMLElement;
        expect(el.tagName).toBe("SPAN");
        expect(el.className).toBe("badge");
        expect(el.textContent).toBe("new");
    });

    test("fragments group children without a wrapper", () => {
        const frag = (
            <>
                <b>x</b>
                <i>y</i>
            </>
        ) as DocumentFragment;
        expect(frag.childNodes).toHaveLength(2);
        expect(Fragment.toString()).toBe("Symbol(myjsx.fragment)");
    });

    // The intrinsic-element JSX types intentionally reject arbitrary object props
    // (only real DOM props + data-*/aria-* are allowed), so these exercise the
    // runtime factory directly — the same code path `<tabbed-zone buche={buche} />`
    // takes once the tag is registered.
    test("object/array props are assigned as live properties, not stringified", () => {
        const payload = { hello: "world" };
        const list = [1, 2, 3];
        const el = jsx("div", { data: payload, items: list }) as HTMLElement & {
            data: unknown;
            items: unknown;
        };
        expect(el.data).toBe(payload);
        expect(el.items).toBe(list);
        // Not stringified onto an attribute.
        expect(el.hasAttribute("data")).toBe(false);
        expect(el.getAttribute("items")).toBeNull();
    });

    test("object props fire a custom element's setter", () => {
        const received: unknown[] = [];
        class RichProp extends HTMLElement {
            set payload(value: unknown) {
                received.push(value);
            }
        }
        customElements.define("rich-prop", RichProp);

        const payload = { n: 42 };
        // createElement upgrades synchronously (the class is defined), so the
        // setter runs during prop application.
        const el = jsx("rich-prop", { payload }) as unknown as RichProp;
        expect(el).toBeInstanceOf(RichProp);
        expect(received).toEqual([payload]);
    });

    test("primitive props remain attributes", () => {
        const el = (<div title="hi" data-count={2} />) as HTMLElement;
        expect(el.getAttribute("title")).toBe("hi");
        // A number is neither object nor function, so it still setAttribute's.
        expect(el.getAttribute("data-count")).toBe("2");
    });
});
