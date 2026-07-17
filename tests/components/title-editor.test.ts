// @vitest-environment happy-dom

import { afterEach, describe, expect, test } from "vitest";
import { showTitleEditor } from "../../src/components/title-editor.ts";

afterEach(() => {
    document.body.replaceChildren();
    document.title = "";
});

function input(el: HTMLElement): HTMLInputElement {
    return el.querySelector("input")!;
}

describe("title-editor", () => {
    test("Enter applies the title and runs the done callback", () => {
        let done = 0;
        const el = showTitleEditor(() => done++);
        const field = input(el);
        field.value = "renamed";
        const ev = new KeyboardEvent("keydown", { key: "Enter", cancelable: true });
        field.dispatchEvent(ev);

        expect(document.title).toBe("renamed");
        expect(done).toBe(1);
        expect(el.isConnected).toBe(false);
        // The focus restore must not let the Enter insert into what regains it.
        expect(ev.defaultPrevented).toBe(true);
    });

    test("Escape cancels but still runs the done callback (the focus goes back)", () => {
        let done = 0;
        const el = showTitleEditor(() => done++);
        input(el).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

        expect(document.title).toBe("");
        expect(done).toBe(1);
        expect(el.isConnected).toBe(false);
    });

    test("a click outside cancels", () => {
        let done = 0;
        const el = showTitleEditor(() => done++);
        el.dispatchEvent(new Event("pointerdown")); // target === overlay
        expect(done).toBe(1);

        input(el).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
        expect(done).toBe(1); // the popup is gone; nothing else fires
    });

    test("the input starts prefilled with the current title", () => {
        document.title = "buche — cq";
        expect(input(showTitleEditor()).value).toBe("buche — cq");
    });
});
