// @vitest-environment happy-dom

import { afterEach, describe, expect, test } from "vitest";
import { showToast } from "../../src/components/toast.ts";

afterEach(() => {
    document.body.replaceChildren();
});

describe("toast", () => {
    test("showToast appends a card with the message to the top-right stack", () => {
        const item = showToast("broken thing");
        const stack = document.querySelector(".buche-toast-stack");
        expect(stack).not.toBeNull();
        expect(stack?.contains(item)).toBe(true);
        expect(item.textContent).toContain("broken thing");
    });

    test("the stack is shared by successive toasts and recreated if removed", () => {
        const a = showToast("one");
        const b = showToast("two");
        expect(document.querySelectorAll(".buche-toast").length).toBe(2);
        expect(document.querySelectorAll(".buche-toast-stack").length).toBe(1);
        document.querySelector(".buche-toast-stack")?.remove();
        showToast("three");
        expect(document.querySelectorAll(".buche-toast-stack").length).toBe(1);
        expect(a.isConnected).toBe(false);
        expect(b.isConnected).toBe(false);
    });

    test("the close button dismisses the toast", () => {
        const item = showToast("bye");
        const close = item.querySelector(".buche-toast-close") as HTMLButtonElement;
        close.click();
        expect(item.isConnected).toBe(false);
    });
});
