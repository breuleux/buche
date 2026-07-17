// @vitest-environment happy-dom

import { afterEach, describe, expect, test } from "vitest";
import "../../src/components/scroll-fader.tsx";

afterEach(() => {
    document.body.replaceChildren();
});

describe("scroll-fader", () => {
    // happy-dom does no layout, so drive update() by stubbing the scroller's
    // scroll metrics and dispatching a scroll event.
    function stubScroll(
        fader: HTMLElement,
        m: { scrollTop: number; scrollHeight: number; clientHeight: number },
    ) {
        const scroller = fader.querySelector<HTMLElement>(".scroll-fader-inner")!;
        for (const [k, v] of Object.entries(m)) {
            Object.defineProperty(scroller, k, { configurable: true, value: v });
        }
        scroller.dispatchEvent(new Event("scroll"));
    }

    const shadows = (fader: HTMLElement) => ({
        top: fader.querySelector(".scroll-shadow-top")!.classList.contains("visible"),
        bottom: fader.querySelector(".scroll-shadow-bottom")!.classList.contains("visible"),
    });

    test("builds inner scroller, content wrapper and two shadows", () => {
        const fader = document.createElement("scroll-fader");
        document.body.append(fader);
        expect(fader.querySelectorAll(".scroll-fader-inner").length).toBe(1);
        expect(fader.querySelectorAll(".scroll-fader-content").length).toBe(1);
        expect(fader.querySelectorAll(".scroll-shadow").length).toBe(2);
    });

    test("relocates authored children into the content wrapper, and `.inner` targets it", () => {
        const fader = document.createElement("scroll-fader");
        const a = document.createElement("p");
        a.textContent = "authored";
        fader.append(a);
        document.body.append(fader);

        const content = fader.querySelector(".scroll-fader-content")!;
        expect(a.parentElement).toBe(content);
        // `.inner` is the append target for new content.
        const b = document.createElement("p");
        (fader as unknown as { inner: HTMLElement }).inner.appendChild(b);
        expect(b.parentElement).toBe(content);
    });

    test("at the bottom: only the top shadow shows", () => {
        const fader = document.createElement("scroll-fader");
        document.body.append(fader);
        // column-reverse reports scrollTop 0 at the bottom.
        stubScroll(fader, { scrollTop: 0, scrollHeight: 1000, clientHeight: 200 });
        expect(shadows(fader)).toEqual({ top: true, bottom: false });
    });

    test("scrolled to the top: only the bottom shadow shows", () => {
        const fader = document.createElement("scroll-fader");
        document.body.append(fader);
        stubScroll(fader, { scrollTop: -800, scrollHeight: 1000, clientHeight: 200 });
        expect(shadows(fader)).toEqual({ top: false, bottom: true });
    });

    test("content shorter than the viewport: no shadows", () => {
        const fader = document.createElement("scroll-fader");
        document.body.append(fader);
        stubScroll(fader, { scrollTop: 0, scrollHeight: 100, clientHeight: 200 });
        expect(shadows(fader)).toEqual({ top: false, bottom: false });
    });
});
