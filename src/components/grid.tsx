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

const DIVIDER_PX = 4;

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
    // divider[i] sits between panes[i] and panes[i+1].
    private dividers: HTMLElement[] = [];
    private initialized = false;
    // Watches panes toggling `hidden`: a hidden pane takes no track (it
    // collapses out of the layout until it shows itself again).
    private observer = new MutationObserver(() => this.resync());

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

        this.dividers = [];
        for (let i = 0; i < n - 1; i++) {
            const divider = this.makeDivider(i);
            this.panes[i].after(divider);
            this.dividers.push(divider);
        }
        for (const pane of this.panes) {
            this.observer.observe(pane, { attributes: true, attributeFilter: ["hidden"] });
        }
        this.resync();
    }

    // Recompute divider visibility and the track template (e.g. after a pane
    // hid or showed itself).
    private resync(): void {
        // A divider shows as soon as one of its neighbours is visible, so the
        // borders of a collapsed region stay draggable: grabbing one reveals
        // the collapsed pane (see startDrag) to grow or shrink it.
        const shown = this.dividers.map(
            (_, k) => !this.panes[k].hidden || !this.panes[k + 1].hidden,
        );
        this.dividers.forEach((d, k) => {
            d.hidden = !shown[k];
        });
        this.applyTemplate();
    }

    private makeDivider(index: number): HTMLElement {
        const divider = document.createElement("div");
        divider.className = this.axis.dividerClass;
        divider.addEventListener("pointerdown", (e) => this.startDrag(e, index, divider));
        return divider;
    }

    // Sum of the fractions of the visible panes (the renormalisation base).
    private visibleTotal(): number {
        let total = 0;
        for (let i = 0; i < this.panes.length; i++) {
            if (!this.panes[i].hidden) {
                total += this.fractions[i];
            }
        }
        return total;
    }

    private applyTemplate(): void {
        // Content panes as `fr` tracks, dividers as fixed pixel tracks, in DOM
        // order; hidden elements generate no box, so they get no track.
        // The visible fractions are renormalised to sum to 1: a grid's `fr`
        // factors only share the free space proportionally when their sum
        // reaches 1 (a sum below 1 leaves the difference undistributed), and
        // collapsed panes would otherwise shrink the ones that remain.
        const total = this.visibleTotal();
        const parts: string[] = [];
        for (const child of this.children) {
            if (!(child instanceof HTMLElement) || child.hidden) {
                continue;
            }
            const i = this.panes.indexOf(child);
            parts.push(
                i === -1 ? `${DIVIDER_PX}px` : `${total > 0 ? this.fractions[i] / total : 0}fr`,
            );
        }
        this.style[this.axis.template] = parts.join(" ");
    }

    private startDrag(event: PointerEvent, index: number, divider: HTMLElement): void {
        event.preventDefault();
        divider.setPointerCapture(event.pointerId);
        divider.classList.add("dragging");

        // A border of a collapsed region: grabbing it reveals that pane —
        // empty, from nothing — so the drag can grow it, typically to shrink
        // the visible neighbour. It then keeps the size it is dragged to.
        let revealed = false;
        for (const k of [index, index + 1]) {
            if (this.panes[k].hidden) {
                this.panes[k].hidden = false;
                this.fractions[k] = 0;
                revealed = true;
            }
        }
        if (revealed) {
            this.resync();
        }

        const start = event[this.axis.clientAxis];
        const a0 = this.fractions[index];
        const b0 = this.fractions[index + 1];
        const combined = a0 + b0;
        // Pixels available to `fr` tracks (total minus the divider tracks).
        const flexPx =
            this[this.axis.extent] - DIVIDER_PX * this.dividers.filter((d) => !d.hidden).length;

        // Tracks are renormalised over the visible panes (see applyTemplate),
        // so one stored fraction unit is worth `total` times the free space.
        const total = this.visibleTotal();

        const onMove = (e: PointerEvent) => {
            if (flexPx <= 0) {
                return;
            }
            const deltaFrac = ((e[this.axis.clientAxis] - start) / flexPx) * total;
            // Only the two neighbouring panes change; their sum is preserved,
            // so every other pane (and divider) stays put. Clamping to
            // [0, combined] makes the divider stop at its neighbour rather
            // than push past it.
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
