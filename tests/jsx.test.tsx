import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Fragment } from "../src/jsx/jsx-runtime.ts";

// A function component, to check that `<Foo/>` calls it.
function Badge({ label }: { label: string }) {
    return <span className="badge">{label}</span>;
}

describe("jsx dom runtime", () => {
    test("intrinsic element with attributes and text", () => {
        const el = (<div id="root">hello</div>) as HTMLElement;
        assert.equal(el.tagName, "DIV");
        assert.equal(el.id, "root");
        assert.equal(el.textContent, "hello");
    });

    test("nested children and numbers", () => {
        const el = (
            <ul>
                <li>a</li>
                <li>{2}</li>
            </ul>
        ) as HTMLElement;
        assert.equal(el.querySelectorAll("li").length, 2);
        assert.equal(el.textContent, "a2");
    });

    test("event handlers are attached", () => {
        let clicks = 0;
        const el = (
            <button type="button" onclick={() => clicks++}>
                go
            </button>
        ) as HTMLElement;
        el.dispatchEvent(new Event("click"));
        assert.equal(clicks, 1);
    });

    test("function components render", () => {
        const el = (<Badge label="new" />) as HTMLElement;
        assert.equal(el.tagName, "SPAN");
        assert.equal(el.className, "badge");
        assert.equal(el.textContent, "new");
    });

    test("fragments group children without a wrapper", () => {
        const frag = (
            <>
                <b>x</b>
                <i>y</i>
            </>
        ) as DocumentFragment;
        assert.equal(frag.childNodes.length, 2);
        assert.equal(Fragment.toString(), "Symbol(myjsx.fragment)");
    });
});
