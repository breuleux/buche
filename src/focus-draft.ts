// DRAFT of the interface focus system — the design is unsettled, so the whole
// current logic (cell selection, prompt focus, and the capture-mode actions on
// the selection) is tucked behind this single FocusManager, owned by
// BucheInterface (see interface.tsx), pending a rethink.

import type { EchoBox } from "./components/echo-box.tsx";
import type { EmbeddedTerm } from "./components/embedded-term.tsx";
import type { PromptCollection } from "./components/prompt-collection.tsx";
import type { IncomingInterfaceMessage } from "./interface-exchange/incoming";
import type { AsyncQueue, BucheErrorMessage } from "./utils.ts";
import type { Zone } from "./zone";

/** Whether an element is rendered (not inside a hidden tab pane, etc.).
 *  Browsers without `checkVisibility` accept everything. */
function isVisible(el: Element): boolean {
    return typeof el.checkVisibility === "function" ? el.checkVisibility() : true;
}

export interface FocusManagerArguments {
    container: Element;
    zones: Array<Zone>;
    interactions: AsyncQueue<IncomingInterfaceMessage | BucheErrorMessage>;
}

export class FocusManager {
    container: Element;
    zones: Array<Zone>;
    interactions: AsyncQueue<IncomingInterfaceMessage | BucheErrorMessage>;
    /** The cell currently selected by the navigation keys. */
    focusedCell: EchoBox | null = null;

    constructor(args: FocusManagerArguments) {
        this.container = args.container;
        this.zones = args.zones;
        this.interactions = args.interactions;
    }

    /** Focus the active prompt of the pane in focus (or the first with prompts),
     *  clearing the cell selection (the prompt is not a cell). */
    focusPrompt(): void {
        const collections = Array.from(
            this.container.querySelectorAll("prompt-collection"),
        ) as PromptCollection[];
        const active = document.activeElement;
        const live = collections.filter((pc) => isVisible(pc) && pc.prompts.length > 0);
        const pc =
            live.find((pc) => active !== null && pc.contains(active)) ??
            live.find((pc) => pc.activePrompt !== null) ??
            live[0];
        if (!pc) {
            return;
        }
        const entry = pc.activePrompt ?? pc.prompts[0];
        pc.showPrompt(entry);
        this.clearFocusedCell();
    }

    /** Whether the DOM focus currently sits in a prompt's editor. */
    promptHasFocus(): boolean {
        const active = document.activeElement;
        return active !== null && active.closest("prompt-collection") !== null;
    }

    /** The visible cells of the currently focused pane, in DOM order. */
    cellBoxes(): Array<EchoBox> {
        const scope = this.activePane() ?? this.container;
        return (Array.from(scope.querySelectorAll("echo-box")) as Array<EchoBox>).filter((box) =>
            isVisible(box),
        );
    }

    /** The deepest zone element holding the focus (DOM or cell selection). */
    activePane(): Element | null {
        const active = document.activeElement;
        let pane: Element | null = null;
        for (const zone of this.zones) {
            const el = zone.element;
            if (!el) {
                continue;
            }
            if (
                (active !== null && el.contains(active)) ||
                (this.focusedCell !== null && el.contains(this.focusedCell))
            ) {
                pane = el;
            }
        }
        return pane;
    }

    /** Move the selection up (-1) or down (+1) through the focused pane's cells.
     *  Past the last cell, down steps onto the prompt (clearing the selection);
     *  from the prompt, up wraps back to the last cell (down, to the first). */
    moveCellFocus(delta: -1 | 1): void {
        const boxes = this.cellBoxes();
        if (this.promptHasFocus()) {
            if (boxes.length > 0) {
                this.setFocusedCell(boxes[delta > 0 ? 0 : boxes.length - 1]);
            }
            return;
        }
        if (boxes.length === 0) {
            return;
        }
        const cur = this.focusedCell !== null ? boxes.indexOf(this.focusedCell) : -1;
        if (cur < 0) {
            this.setFocusedCell(boxes[delta > 0 ? 0 : boxes.length - 1]);
            return;
        }
        if (delta > 0 && cur === boxes.length - 1) {
            this.focusPrompt();
            return;
        }
        this.setFocusedCell(boxes[Math.max(0, cur + delta)]);
    }

    /** Select a cell: highlight it and move the DOM focus into its active view
     *  (the embedded terminal, so keystrokes reach the pty). */
    setFocusedCell(box: EchoBox | null): void {
        const previous = this.focusedCell;
        if (previous && previous !== box) {
            previous.classList.remove("cell-focused");
        }
        this.focusedCell = box;
        box?.classList.add("cell-focused");
        // The focused cell's background brightens (echo-box.css); repaint the
        // embedded terminals of both cells so their canvas matches.
        this.refreshCellBackground(previous);
        this.refreshCellBackground(box);
        if (!box) {
            return;
        }
        // Environments without layout (tests) may lack scrollIntoView.
        box.scrollIntoView?.({ block: "nearest" });
        this.focusCellContent(box);
    }

    private refreshCellBackground(box: EchoBox | null): void {
        // Stub terminals without the real element (tests) may lack the method.
        const terms = (box?.querySelectorAll("embedded-term") ?? []) as Array<
            Partial<EmbeddedTerm>
        >;
        for (const term of terms) {
            term.refreshBackground?.();
        }
    }

    /** Drop the cell selection (highlight and reference), leaving focus alone. */
    clearFocusedCell(): void {
        this.setFocusedCell(null);
    }

    /** Route the DOM focus into a cell's active view: its embedded terminal if
     *  there is one (keystrokes then go to the pty), else the view container,
     *  else the box itself. (GUI views focus their container for now.) */
    focusCellContent(box: EchoBox): void {
        const view = box.activeView !== null ? box.getView(box.activeView) : null;
        const term = view?.querySelector("embedded-term") as EmbeddedTerm | null;
        if (term) {
            term.focus();
            return;
        }
        const target = view ?? box;
        target.tabIndex = -1;
        target.focus();
    }

    /** SIGTERM (SIGKILL when already unresponsive) to the selected cell, like
     *  the zone's close handler, but without arming destroy-when-done. */
    killFocusedCell(): void {
        const box = this.focusedCell;
        const entry = box?.boundEntry;
        if (!box || !entry) {
            return;
        }
        const code = box.status === "unresponsive" ? 9 : 15;
        this.interactions.push({ type: "user_signal", code, entry });
    }

    /** Behave exactly like clicking the selected cell's ✕ button. */
    closeFocusedCell(): void {
        this.focusedCell?.dispatchEvent(new CustomEvent<null>("close", { bubbles: true }));
    }

    /** Move the DOM focus onto the selected cell (no-op when the selection
     *  already holds it, e.g. inside the terminal). */
    focusFocusedCell(): void {
        const box = this.focusedCell;
        if (!box?.isConnected) {
            this.focusedCell = null;
            return;
        }
        if (document.activeElement !== null && box.contains(document.activeElement)) {
            return;
        }
        box.tabIndex = -1;
        box.focus();
    }
}
