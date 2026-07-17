// A full terminal view as a custom element: `<buche-term>`.
//
//   const term = document.createElement("buche-term") as BucheTerm;
//   term.cells;     // the <scroll-fader> that holds cell content
//   term.prompts;   // the <prompt-collection> at the bottom
//
// It stacks a <scroll-fader> on top of a <prompt-collection>:
//
//   ┌ buche-term ──────────────────┐
//   │ scroll-fader  (cells)        │  grows to fill remaining space
//   │   …cell content…             │
//   │                              │
//   ├──────────────────────────────┤
//   │ prompt-collection  (prompts) │  pinned to the bottom
//   └──────────────────────────────┘
//
// Appearance lives in the companion stylesheet `buche-term.css` (or the
// consolidated components.css).

// Bare side-effect imports register the child custom elements. They must not be
// `import type` (which biome would fold a value-only-used-as-type import into) —
// that would drop the module and its customElements.define, leaving
// <scroll-fader> and <prompt-collection> unregistered.
import "./scroll-fader.tsx";
import "./prompt-collection.tsx";
import type { DomProps } from "myjsx/jsx-runtime";
import type { PromptCollection } from "./prompt-collection.tsx";
import type { ScrollFader } from "./scroll-fader.tsx";

export class BucheTerm extends HTMLElement {
    private initialized = false;
    private fader!: ScrollFader;
    private promptCollection!: PromptCollection;

    connectedCallback(): void {
        this.ensureSetup();
    }

    private ensureSetup(): void {
        if (this.initialized) {
            return;
        }
        this.initialized = true;

        this.fader = document.createElement("scroll-fader") as ScrollFader;
        this.promptCollection = document.createElement("prompt-collection") as PromptCollection;

        this.append(this.fader, this.promptCollection);
    }

    /** The <scroll-fader> holding cell content. */
    get cells(): ScrollFader {
        this.ensureSetup();
        return this.fader;
    }

    /** The <prompt-collection> at the bottom. */
    get prompts(): PromptCollection {
        this.ensureSetup();
        return this.promptCollection;
    }
}

if (typeof customElements !== "undefined") {
    if (!customElements.get("buche-term")) {
        customElements.define("buche-term", BucheTerm);
    }
}

declare module "myjsx/jsx-runtime" {
    namespace JSX {
        interface CustomElements {
            "buche-term": DomProps<BucheTerm>;
        }
    }
}
