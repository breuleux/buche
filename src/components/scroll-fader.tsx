// A scrollable region that fades its edges: a shadow appears at the top while
// there is content scrolled off above, and at the bottom while there is content
// below. The scroll container uses `flex-direction: column-reverse`, which pins
// the view to the bottom for free — so as content is appended it stays scrolled
// to the newest item unless the user has scrolled up. (Ported from ~/code/buche.)
//
//   <scroll-fader>…lots of content…</scroll-fader>
//
// or programmatically: `scrollFader.inner.appendChild(node)` — append to `.inner`
// and it sticks to the bottom.
//
// Appearance lives in the companion stylesheet `scroll-fader.css` (or the
// consolidated components.css).

import type { DomProps } from "myjsx/jsx-runtime";

// Snap-back tolerance when content grows: about one text line — enough to heal
// a stray layout offset, well short of a screen (a reader who scrolled up
// stays put).
const GROWTH_STICK_PX = 24;

export class ScrollFader extends HTMLElement {
    private initialized = false;
    // The `overflow` container, laid out column-reverse so it stays bottom-pinned.
    private scroller!: HTMLElement;
    // Natural top-to-bottom wrapper for the content, so authored order is kept
    // (column-reverse would otherwise flip sibling order); it is the single child
    // of the scroller, so appending to it keeps the bottom-pinning behaviour.
    private content!: HTMLElement;
    private shadowTop!: HTMLElement;
    private shadowBottom!: HTMLElement;

    connectedCallback(): void {
        this.ensureSetup();
    }

    private ensureSetup(): void {
        if (this.initialized) {
            return;
        }
        this.initialized = true;

        // Move any authored light-DOM children into the content wrapper.
        const authored = Array.from(this.childNodes);

        this.shadowTop = document.createElement("div");
        this.shadowBottom = document.createElement("div");
        this.shadowTop.className = "scroll-shadow scroll-shadow-top";
        this.shadowBottom.className = "scroll-shadow scroll-shadow-bottom";

        this.scroller = document.createElement("div");
        this.scroller.className = "scroll-fader-inner";
        this.content = document.createElement("div");
        this.content.className = "scroll-fader-content";
        this.scroller.appendChild(this.content);

        this.append(this.shadowTop, this.shadowBottom, this.scroller);
        this.content.append(...authored);

        this.scroller.addEventListener("scroll", () => this.update());
        // Re-evaluate the shadows whenever the content changes (e.g. lines added).
        // A content change is also the moment the bottom-pinning matters: the
        // `column-reverse` anchor only holds at exactly scrollTop 0, and various
        // layout events (a cell-resize drag's counter-scroll, native scroll
        // anchoring when an embedded terminal's grid grows or collapses on alt
        // exit) can leave the view a few px — up to about a line — off the
        // bottom, silently disabling the pin so new content slips below the
        // fold. Re-engage it: snap to 0 when the view is within a hair of the
        // bottom at any change, and up to a line's worth when the content grew
        // (growth at the bottom is what the user follows; a reader genuinely
        // scrolled up by more than a line is left alone).
        new MutationObserver(() => {
            const { scrollTop, scrollHeight } = this.scroller;
            const grew = scrollHeight > this.lastScrollHeight;
            this.lastScrollHeight = scrollHeight;
            const tolerance = grew ? GROWTH_STICK_PX : 2;
            if (scrollTop !== 0 && Math.abs(scrollTop) <= tolerance) {
                this.scroller.scrollTop = 0;
            }
            this.update();
        }).observe(this.content, { childList: true, subtree: true });
        this.update();
    }

    // Scroll height seen at the last content change (to tell growth from shrink).
    private lastScrollHeight = 0;

    /** Append content here; new content sticks to the bottom. */
    get inner(): HTMLElement {
        this.ensureSetup();
        return this.content;
    }

    private update(): void {
        const { scrollTop, scrollHeight, clientHeight } = this.scroller;
        const maxScroll = scrollHeight - clientHeight;
        // column-reverse reports scrollTop as 0 at the bottom, negative going up.
        const scrolled = Math.abs(scrollTop);
        const atBottom = scrolled <= 2;
        const atTop = maxScroll <= 2 || scrolled >= maxScroll - 4;
        this.shadowTop.classList.toggle("visible", !atTop);
        this.shadowBottom.classList.toggle("visible", !atBottom);
    }
}

if (typeof customElements !== "undefined") {
    if (!customElements.get("scroll-fader")) {
        customElements.define("scroll-fader", ScrollFader);
    }
}

declare module "myjsx/jsx-runtime" {
    namespace JSX {
        interface CustomElements {
            "scroll-fader": DomProps<ScrollFader>;
        }
    }
}
