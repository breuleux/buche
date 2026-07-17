// Resizable split layouts as custom elements.
//
//   <grid-rows>
//     <div>A</div>
//     <div>B</div>
//   </grid-rows>
//
// stacks A and B vertically with a draggable divider between them. `<grid-columns>`
// does the same horizontally. With 3+ panes there are 2+ dividers; dragging one
// only resizes its two neighbouring panes, so it stops at the next divider rather
// than pushing it along.
//
// Appearance and layout live in the companion stylesheet `grid.css`; include it
// on any page that uses these elements (or the consolidated components.css).

import type { DomProps } from "myjsx/jsx-runtime";

const DIVIDER_PX = 6;

interface Axis {
    // The flex/grid track property that holds the pane sizes.
    template: "gridTemplateRows" | "gridTemplateColumns";
    // Fixed cross-axis track so panes fill the container.
    cross: "gridTemplateColumns" | "gridTemplateRows";
    // Client coordinate that changes as the divider is dragged.
    clientAxis: "clientY" | "clientX";
    // Container extent along the drag axis.
    extent: "clientHeight" | "clientWidth";
    dividerClass: string;
}

const ROWS: Axis = {
    template: "gridTemplateRows",
    cross: "gridTemplateColumns",
    clientAxis: "clientY",
    extent: "clientHeight",
    dividerClass: "grid-divider-row",
};

const COLUMNS: Axis = {
    template: "gridTemplateColumns",
    cross: "gridTemplateRows",
    clientAxis: "clientX",
    extent: "clientWidth",
    dividerClass: "grid-divider-col",
};

class ResizableGrid extends HTMLElement {
    private axis: Axis;
    // One fraction per content pane; the fractions sum to 1 and drive the `fr`
    // tracks, so panes stay proportional when the container is resized.
    private fractions: number[] = [];
    private panes: HTMLElement[] = [];
    private initialized = false;

    constructor(axis: Axis) {
        super();
        this.axis = axis;
    }

    connectedCallback(): void {
        if (this.initialized) {
            return;
        }
        this.initialized = true;
        this.build();
    }

    private build(): void {
        // Snapshot the authored children as the content panes, then interleave
        // dividers between them.
        this.panes = Array.from(this.children).filter(
            (c): c is HTMLElement => c instanceof HTMLElement,
        );
        const n = this.panes.length;
        this.fractions = this.panes.map(() => 1 / Math.max(n, 1));

        // Single track on the cross axis so panes fill the container.
        this.style[this.axis.cross] = "minmax(0, 1fr)";

        for (let i = 0; i < n - 1; i++) {
            const divider = this.makeDivider(i);
            this.panes[i].after(divider);
        }
        this.applyTemplate();
    }

    private makeDivider(index: number): HTMLElement {
        const divider = document.createElement("div");
        divider.className = this.axis.dividerClass;
        divider.addEventListener("pointerdown", (e) => this.startDrag(e, index, divider));
        return divider;
    }

    private applyTemplate(): void {
        // Content panes as `fr` tracks, dividers as fixed pixel tracks.
        const parts: string[] = [];
        this.fractions.forEach((f, i) => {
            if (i > 0) {
                parts.push(`${DIVIDER_PX}px`);
            }
            parts.push(`${f}fr`);
        });
        this.style[this.axis.template] = parts.join(" ");
    }

    private startDrag(event: PointerEvent, index: number, divider: HTMLElement): void {
        event.preventDefault();
        divider.setPointerCapture(event.pointerId);
        divider.classList.add("dragging");

        const start = event[this.axis.clientAxis];
        const a0 = this.fractions[index];
        const b0 = this.fractions[index + 1];
        const combined = a0 + b0;
        // Pixels available to `fr` tracks (total minus all divider tracks).
        const flexPx = this[this.axis.extent] - DIVIDER_PX * (this.fractions.length - 1);

        const onMove = (e: PointerEvent) => {
            if (flexPx <= 0) {
                return;
            }
            const deltaFrac = (e[this.axis.clientAxis] - start) / flexPx;
            // Only the two neighbouring panes change; their sum is preserved, so
            // every other pane (and divider) stays put. Clamping to [0, combined]
            // makes the divider stop at its neighbour rather than push past it.
            const a = Math.max(0, Math.min(combined, a0 + deltaFrac));
            this.fractions[index] = a;
            this.fractions[index + 1] = combined - a;
            this.applyTemplate();
        };

        const onUp = (e: PointerEvent) => {
            divider.releasePointerCapture(e.pointerId);
            divider.classList.remove("dragging");
            divider.removeEventListener("pointermove", onMove);
            divider.removeEventListener("pointerup", onUp);
        };

        divider.addEventListener("pointermove", onMove);
        divider.addEventListener("pointerup", onUp);
    }
}

export class GridRows extends ResizableGrid {
    constructor() {
        super(ROWS);
    }
}

export class GridColumns extends ResizableGrid {
    constructor() {
        super(COLUMNS);
    }
}

if (typeof customElements !== "undefined") {
    if (!customElements.get("grid-rows")) {
        customElements.define("grid-rows", GridRows);
    }
    if (!customElements.get("grid-columns")) {
        customElements.define("grid-columns", GridColumns);
    }
}

declare module "myjsx/jsx-runtime" {
    namespace JSX {
        interface CustomElements {
            "grid-rows": DomProps<GridRows>;
            "grid-columns": DomProps<GridColumns>;
        }
    }
}
