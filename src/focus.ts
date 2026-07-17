// Generic spatial focus navigation over elements tagged `focusable`.
//
//   const fm = new FocusManager(root);
//   <div focusable>…</div>
//
// The manager knows nothing about what the focusable elements are; it only uses
// the DOM structure and layout:
//
//   * Clicking inside a focusable element focuses it (the innermost one),
//     except inside a `nofocus` element (e.g. a close button), which leaves
//     both the focus and the DOM focus where they are. Clicks inside iframes
//     aren't visible to the page; they are detected from the focus entering
//     the iframe (the page's window blurs, with the iframe as activeElement).
//   * An element whose content can now take the focus (e.g. a cell whose
//     terminal was just created) dispatches a bubbling "focus-commit-request"
//     event: if it is (inside) the focused element and commits aren't held,
//     the focus is committed, so it moves into that content.
//   * `commitFocus()` calls `commitFocus()` on the focused element, if it has
//     one (see {@link FocusCommittable}). It is meant to be called when a
//     navigation is over, so that elements can defer part of taking the focus
//     (e.g. moving it into an iframe) until then. It is also called
//     automatically when the focus moves because the focused element was
//     removed — unless `holdCommits` is set (e.g. during a navigation, which
//     will commit when it ends).
//   * `move(direction, mode)` moves the focus, in one of three modes (binding
//     keys to it is up to the caller); `find(from, direction, mode)` tells
//     where that would go from any focusable, without moving anything:
//       - "neighbour": the flex step below only.
//       - "jump": the layout jump below only, restricted to elements outside
//         the focused element's closest focusable container, so that it always
//         leaves that container (e.g. a quadrant).
//       - "mix": the flex step, else the layout jump — i.e. "neighbour", and
//         "jump" if that did nothing.
//
//     Flex step:
//       - If an ancestor of the focused element is a flex container laid out
//         along the arrow's axis, the focus steps to the previous/next flex item
//         (direct child) of that container that holds focusables: the item
//         itself if it is focusable, otherwise the focusable inside it (with no
//         focusable in between) closest to the current one. Flex containers
//         with fewer than two such items are skipped.
//       - At the first/last item, the same is tried with the next such flex
//         ancestor up; nothing happens when there is none.
//
//     Layout jump:
//       - The focus goes to the closest focusable element in that direction
//         (straight ahead: overlapping the current one on the cross axis) — or
//         rather to its highest focusable ancestor that does not contain the
//         current focus.
//   * Focusing a container (a focusable with focusable descendants) focuses its
//     last focused leaf instead (or its first leaf, if it has no valid memory).
//   * When the focused element is removed, focus returns to the most recent
//     still-valid element in the history. When it merely becomes invisible (e.g.
//     its tab was switched away), focus moves to the closest visible focusable
//     ancestor, resolved to a leaf.
//   * Invisible elements are ignored.
//
// State is reflected on the DOM for styling:
//   [focused]     the focused leaf
//   [focus-path]  every focusable ancestor of the focused leaf
//
// Each focus is recorded in the history with tags:
//   * its kind: the value of the `focusable` attribute, if any (e.g.
//     `focusable="cell"` → "cell");
//   * its source, i.e. how it was focused:
//       "click"    a click (pointer press) inside it
//       "nav"      navigation with `move`
//       "dom"      the DOM focus landed in it (Tab, or a component's .focus())
//       "restore"  the previous focus was destroyed or hidden
//       "api"      a `focus()` call (the caller may pass another source)
//       "auto"     an `expect(id)` was fulfilled (see below)
//
// `expect(id)` arranges for the element with that id to be focused as soon as
// it is in the root, focusable and visible (it may already be, or appear or
// become visible later), then committed (unless `holdCommits` is set). It is
// cancelled if the focus moves first (click, navigation, DOM focus, `focus()`;
// not a restore after the focused element was removed), by a new `expect`, or
// by `expect(null)`. Checking costs one id lookup per DOM mutation batch, and
// only while an expectation is pending.
//
// A bubbling "focus-change" event (detail: { previous, current, tags }) is
// dispatched on the root whenever the focus changes.

export type Direction = "up" | "down" | "left" | "right";

/** How to move: flex neighbour only, layout jump only, or neighbour else jump. */
export type NavigationMode = "neighbour" | "jump" | "mix";

/** How a focus came about (see the header comment). */
export type FocusSource = "click" | "nav" | "dom" | "restore" | "api" | "auto";

/** A focusable element that does something more on `FocusManager.commitFocus()`. */
export interface FocusCommittable {
    commitFocus(): void;
}

/** One focus in the history. */
export interface FocusRecord {
    element: HTMLElement;
    /** The element's kind (if it has one), then the focus's source. */
    tags: string[];
}

export interface FocusChangeDetail {
    previous: HTMLElement | null;
    current: HTMLElement | null;
    /** Tags of the new focus (empty when the focus was lost). */
    tags: string[];
}

export interface FocusManagerOptions {
    /**
     * Number of past focuses to remember (default 10). On top of those, the
     * latest focus for each combination of tags is always kept.
     */
    historySize?: number;
    /** Attribute that marks elements as focusable (default "focusable"). */
    attribute?: string;
}

// Native elements that should receive DOM focus when their focusable is focused.
const EDITABLE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';

// Elements whose clicks don't change the focus.
const NOFOCUS = "[nofocus]";

// Tolerance (px) for edge comparisons in the geometric search.
const TOLERANCE = 2;

interface Rect {
    top: number;
    bottom: number;
    left: number;
    right: number;
}

export class FocusManager {
    readonly root: HTMLElement;
    private readonly attribute: string;
    private readonly selector: string;
    private readonly historySize: number;

    /**
     * While true, automatic commits (after the focused element is removed)
     * are skipped; set it during a navigation that will commit when it ends.
     */
    holdCommits = false;

    private currentEl: HTMLElement | null = null;
    // The id passed to `expect`, while pending.
    private expected: string | null = null;
    private expectScheduled = false;
    // Focusable ancestors of the current leaf, innermost first, captured when it
    // was focused: once it is detached we can no longer walk up from it.
    private currentPath: HTMLElement[] = [];
    // Most recent last; includes the current element. An element appears once,
    // with the tags of its latest focus.
    private past: FocusRecord[] = [];
    // Container → the last leaf focused within it.
    private lastLeaf = new WeakMap<HTMLElement, HTMLElement>();
    private observer: MutationObserver;
    private checkScheduled = false;

    constructor(root: HTMLElement, options: FocusManagerOptions = {}) {
        this.root = root;
        this.attribute = options.attribute ?? "focusable";
        this.selector = `[${this.attribute}]`;
        this.historySize = options.historySize ?? 10;

        root.addEventListener("pointerdown", this.onPointerDown, true);
        root.addEventListener("mousedown", this.onMouseDown, true);
        root.addEventListener("focusin", this.onFocusIn);
        root.addEventListener("focus-commit-request", this.onCommitRequest);
        window.addEventListener("blur", this.onWindowBlur);

        // Removal or hiding of the focused element shows up as a mutation.
        // An expected element may also appear by getting its id, or by
        // becoming visible.
        this.observer = new MutationObserver((records) => {
            if (this.affectsCurrent(records)) {
                this.scheduleCheck();
            }
            if (this.expected !== null) {
                this.scheduleExpectCheck();
            }
        });
        this.observer.observe(root, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ["style", "class", "hidden", "id"],
        });
    }

    dispose(): void {
        this.root.removeEventListener("pointerdown", this.onPointerDown, true);
        this.root.removeEventListener("mousedown", this.onMouseDown, true);
        this.root.removeEventListener("focusin", this.onFocusIn);
        this.root.removeEventListener("focus-commit-request", this.onCommitRequest);
        window.removeEventListener("blur", this.onWindowBlur);
        this.observer.disconnect();
    }

    /**
     * The focused leaf, or null. Also null in the brief window after the
     * focused element was removed or hidden, before the focus is moved on.
     */
    get current(): HTMLElement | null {
        const el = this.currentEl;
        return el && this.valid(el) ? el : null;
    }

    /** Tags of the current focus (see {@link FocusRecord}); empty when there is none. */
    get currentTags(): readonly string[] {
        const current = this.current;
        const record = this.past.at(-1);
        return current && record?.element === current ? [...record.tags] : [];
    }

    /** Past focuses, most recent last (the current one included). */
    get history(): readonly FocusRecord[] {
        return this.past
            .filter((r) => r.element.isConnected)
            .map((r) => ({ element: r.element, tags: [...r.tags] }));
    }

    // ── Public operations ───────────────────────────────────────────────────

    /** Focus `el` (a container is resolved to its last focused leaf). */
    focus(el: HTMLElement, source: FocusSource = "api"): void {
        this.setCurrent(this.resolve(el), true, source);
    }

    /**
     * Focus the element with this id as soon as it is available, unless the
     * focus moves first (see the header comment). `null` cancels. Replaces any
     * pending expectation.
     */
    expect(id: string | null): void {
        this.expected = id;
        this.checkExpected();
    }

    /**
     * Go back to the most recent element of the history (before the current
     * one) that is still there and visible, as when the focused element is
     * removed; then commit, unless commits are held. Returns whether the focus
     * moved.
     */
    back(): boolean {
        const target = this.previousValid();
        if (!target) {
            return false;
        }
        this.setCurrent(this.resolve(target), true, "restore");
        if (!this.holdCommits) {
            this.commitFocus();
        }
        return true;
    }

    /** The id passed to `expect`, while it is pending. */
    get expecting(): string | null {
        return this.expected;
    }

    /** Let the focused element finish taking the focus (see {@link FocusCommittable}). */
    commitFocus(): void {
        (this.current as (HTMLElement & Partial<FocusCommittable>) | null)?.commitFocus?.();
    }

    /** Move the focus in a direction. Returns whether the focus moved. */
    move(direction: Direction, mode: NavigationMode = "mix"): boolean {
        const current = this.current;
        if (!current) {
            const first = this.topLevel(this.root)[0];
            if (first) {
                this.focus(first, "nav");
                return true;
            }
            return false;
        }
        const target = this.find(current, direction, mode);
        if (!target) {
            return false;
        }
        this.focus(target, "nav");
        return true;
    }

    /**
     * The focusable that `move(direction, mode)` would go to from `from` (a
     * visible focusable within the root), without moving the focus; null if
     * there is none. It is returned as is: a container is not resolved to the
     * leaf that focusing it would pick.
     */
    find(
        from: HTMLElement,
        direction: Direction,
        mode: NavigationMode = "mix",
    ): HTMLElement | null {
        if (!this.isFocusable(from) || !this.valid(from)) {
            return null;
        }
        return (
            (mode !== "jump" ? this.flexStep(from, direction) : null) ??
            (mode !== "neighbour"
                ? this.spatialStep(from, direction, this.focusableParent(from))
                : null)
        );
    }

    // ── Structure ───────────────────────────────────────────────────────────

    private isFocusable(el: Element): boolean {
        return el instanceof HTMLElement && el.matches(this.selector);
    }

    private visible(el: HTMLElement): boolean {
        if (typeof el.checkVisibility === "function") {
            return el.checkVisibility({ visibilityProperty: true } as CheckVisibilityOptions);
        }
        return el.getClientRects().length > 0;
    }

    private valid(el: HTMLElement | null | undefined): boolean {
        return !!el && el.isConnected && this.root.contains(el) && this.visible(el);
    }

    /** The closest focusable strict ancestor of `el` within the root. */
    private focusableParent(el: HTMLElement): HTMLElement | null {
        const p = el.parentElement?.closest<HTMLElement>(this.selector) ?? null;
        return p && p !== this.root && this.root.contains(p) ? p : null;
    }

    /** Focusable ancestors of `el`, innermost first. */
    private focusableAncestors(el: HTMLElement): HTMLElement[] {
        const rval: HTMLElement[] = [];
        for (let p = this.focusableParent(el); p; p = this.focusableParent(p)) {
            rval.push(p);
        }
        return rval;
    }

    /** Visible focusables under `container` with no focusable between them and it. */
    private topLevel(container: HTMLElement): HTMLElement[] {
        // Native queries rather than a JS walk: the subtree may hold huge
        // amounts of non-focusable content (e.g. terminal output). Only the
        // focusables themselves are visited here.
        const rval: HTMLElement[] = [];
        for (const el of container.querySelectorAll<HTMLElement>(this.selector)) {
            const p = el.parentElement?.closest(this.selector);
            // Top-level: no focusable between `el` and the container.
            if ((!p || p === container || p.contains(container)) && this.visible(el)) {
                rval.push(el);
            }
        }
        return rval;
    }

    /** Resolve a focusable to the leaf that should actually receive the focus. */
    private resolve(el: HTMLElement): HTMLElement {
        // Fast path for leaves (the common case: every click lands on one).
        if (!el.querySelector(this.selector)) {
            return el;
        }
        const children = this.topLevel(el);
        if (children.length === 0) {
            return el;
        }
        const remembered = this.lastLeaf.get(el);
        if (remembered && remembered !== el && el.contains(remembered) && this.valid(remembered)) {
            return this.resolve(remembered);
        }
        for (let i = this.past.length - 1; i >= 0; i--) {
            const leaf = this.past[i].element;
            if (leaf !== el && el.contains(leaf) && this.valid(leaf)) {
                return this.resolve(leaf);
            }
        }
        return this.resolve(children[0]);
    }

    // ── Focus state ─────────────────────────────────────────────────────────

    private setCurrent(el: HTMLElement | null, domFocus: boolean, source: FocusSource): void {
        const previous = this.currentEl;
        if (el === previous) {
            if (el && domFocus) {
                this.applyDomFocus(el);
            }
            return;
        }
        // The focus moved before the expected element showed up: forget it.
        // (Not when the focus was just restored after a removal, which the
        // user didn't ask for.)
        if (source !== "restore") {
            this.expected = null;
        }
        previous?.removeAttribute("focused");
        for (const p of this.currentPath) {
            p.removeAttribute("focus-path");
        }

        this.currentEl = el;
        this.currentPath = el ? this.focusableAncestors(el) : [];

        if (el) {
            el.setAttribute("focused", "");
            for (const p of this.currentPath) {
                p.setAttribute("focus-path", "");
                this.lastLeaf.set(p, el);
            }
            this.past = this.past.filter((r) => r.element !== el && r.element.isConnected);
            this.past.push({ element: el, tags: this.tagsFor(el, source) });
            this.trimHistory();
            if (domFocus) {
                this.applyDomFocus(el);
            }
            el.scrollIntoView({ block: "nearest", inline: "nearest" });
        }

        this.root.dispatchEvent(
            new CustomEvent<FocusChangeDetail>("focus-change", {
                detail: { previous, current: el, tags: el ? this.tagsFor(el, source) : [] },
                bubbles: true,
            }),
        );
    }

    // Drop the oldest records beyond `historySize`, except that the latest
    // record for each combination of tags is kept regardless (so that e.g. the
    // last focused prompt is always remembered).
    private trimHistory(): void {
        let excess = this.past.length - this.historySize;
        if (excess <= 0) {
            return;
        }
        const latest = new Set<FocusRecord>();
        const seen = new Set<string>();
        for (let i = this.past.length - 1; i >= 0; i--) {
            const key = this.past[i].tags.join(" ");
            if (!seen.has(key)) {
                seen.add(key);
                latest.add(this.past[i]);
            }
        }
        this.past = this.past.filter((r) => {
            if (excess > 0 && !latest.has(r)) {
                excess--;
                return false;
            }
            return true;
        });
    }

    private tagsFor(el: HTMLElement, source: FocusSource): string[] {
        const kind = el.getAttribute(this.attribute);
        return kind ? [kind, source] : [source];
    }

    // Move the DOM focus into `el`: to itself if it is tabbable, else to the
    // first editable element inside it. Otherwise, drop a DOM focus that lies
    // outside of it, so keys don't go to a stale element.
    private applyDomFocus(el: HTMLElement): void {
        const active = document.activeElement;
        if (active instanceof HTMLElement && el.contains(active)) {
            return;
        }
        const target = el.hasAttribute("tabindex") ? el : el.querySelector<HTMLElement>(EDITABLE);
        if (target) {
            target.focus({ preventScroll: true });
        } else if (active instanceof HTMLElement && active !== document.body) {
            active.blur();
        }
    }

    // Whether mutations may have removed or hidden the focused element: a
    // removed subtree containing it, or a style/class/hidden change on it or
    // an ancestor. Everything else (e.g. content streaming into some other
    // cell, or changes inside the focused element) is skipped without
    // touching layout or style.
    private affectsCurrent(records: MutationRecord[]): boolean {
        const current = this.currentEl;
        if (!current) {
            return false;
        }
        for (const r of records) {
            if (r.type === "attributes") {
                if (r.target.contains(current)) {
                    return true;
                }
            } else {
                for (const node of r.removedNodes) {
                    if (node.contains(current)) {
                        return true;
                    }
                }
            }
        }
        return false;
    }

    // The most recent valid element of the history other than the current one.
    private previousValid(): HTMLElement | null {
        for (let i = this.past.length - 1; i >= 0; i--) {
            const el = this.past[i].element;
            if (el !== this.currentEl && this.valid(el)) {
                return el;
            }
        }
        return null;
    }

    private scheduleExpectCheck(): void {
        if (this.expectScheduled) {
            return;
        }
        this.expectScheduled = true;
        queueMicrotask(() => {
            this.expectScheduled = false;
            this.checkExpected();
        });
    }

    // Fulfil a pending `expect` if its element is now available. A single id
    // lookup (indexed by the browser) unless the element is there.
    private checkExpected(): void {
        const id = this.expected;
        if (id === null) {
            return;
        }
        const el = this.root.ownerDocument.getElementById(id);
        if (!el || !this.root.contains(el) || !this.isFocusable(el) || !this.valid(el)) {
            return;
        }
        this.expected = null;
        this.setCurrent(this.resolve(el), true, "auto");
        if (!this.holdCommits) {
            this.commitFocus();
        }
    }

    private scheduleCheck(): void {
        if (this.checkScheduled) {
            return;
        }
        this.checkScheduled = true;
        queueMicrotask(() => {
            this.checkScheduled = false;
            this.check();
        });
    }

    // React to the focused element disappearing.
    private check(): void {
        const current = this.currentEl;
        if (!current) {
            return;
        }
        this.past = this.past.filter((r) => r.element.isConnected);
        if (this.valid(current)) {
            return;
        }
        // Still there but hidden: go to the closest visible container.
        if (current.isConnected) {
            const container = this.currentPath.find((p) => this.valid(p));
            if (container) {
                this.setCurrent(this.resolve(container), true, "restore");
                return;
            }
        }
        // Destroyed (or nothing visible around it): go back in history.
        const removed = !current.isConnected;
        const target =
            this.previousValid() ??
            this.currentPath.find((p) => this.valid(p)) ??
            this.topLevel(this.root)[0];
        this.setCurrent(target ? this.resolve(target) : null, true, "restore");
        if (removed && !this.holdCommits) {
            this.commitFocus();
        }
    }

    // ── Navigation ──────────────────────────────────────────────────────────

    // Step within the nearest flex ancestor laid out along the direction's axis
    // and holding focusables in at least two of its items (direct children).
    // The focus goes to the neighbouring item — to the item itself if it is
    // focusable, else to its top-level focusable closest to the current one.
    // At its edge, the next such ancestor up is tried; null when none is left.
    private flexStep(current: HTMLElement, direction: Direction): HTMLElement | null {
        const vertical = direction === "up" || direction === "down";
        const forward = direction === "down" || direction === "right";
        for (let node = current.parentElement; node && this.root.contains(node); ) {
            const style = getComputedStyle(node);
            const isFlex = style.display === "flex" || style.display === "inline-flex";
            const column = style.flexDirection.startsWith("column");
            if (isFlex && column === vertical) {
                const items = [...node.children].filter(
                    (c): c is HTMLElement =>
                        c instanceof HTMLElement && this.candidatesIn(c).length > 0,
                );
                const own = items.find((item) => item.contains(current));
                if (own && items.length > 1) {
                    // Order by on-screen position, which accounts for *-reverse.
                    const key = (el: HTMLElement) => {
                        const r = el.getBoundingClientRect();
                        return vertical ? r.top + r.bottom : r.left + r.right;
                    };
                    items.sort((a, b) => key(a) - key(b));
                    const next = items[items.indexOf(own) + (forward ? 1 : -1)];
                    if (next) {
                        return this.closest(current, this.candidatesIn(next));
                    }
                }
            }
            node = node.parentElement;
        }
        return null;
    }

    /** `el` itself if focusable, else its top-level focusables (visible only). */
    private candidatesIn(el: HTMLElement): HTMLElement[] {
        if (this.isFocusable(el)) {
            return this.visible(el) ? [el] : [];
        }
        return this.topLevel(el);
    }

    private closest(current: HTMLElement, candidates: HTMLElement[]): HTMLElement | null {
        const from = current.getBoundingClientRect();
        let best: HTMLElement | null = null;
        let bestDistance = Number.POSITIVE_INFINITY;
        for (const cand of candidates) {
            const to = cand.getBoundingClientRect();
            const dx = Math.max(0, to.left - from.right, from.left - to.right);
            const dy = Math.max(0, to.top - from.bottom, from.top - to.bottom);
            if (dx + dy < bestDistance) {
                bestDistance = dx + dy;
                best = cand;
            }
        }
        return best;
    }

    // The closest focusable in the direction, lifted to its highest focusable
    // ancestor that doesn't contain the current element.
    // When `outside` is given, only candidates outside of it are considered.
    private spatialStep(
        current: HTMLElement,
        direction: Direction,
        outside: HTMLElement | null,
    ): HTMLElement | null {
        const from = current.getBoundingClientRect();
        let best: HTMLElement | null = null;
        let bestScore = Number.POSITIVE_INFINITY;
        for (const cand of this.root.querySelectorAll<HTMLElement>(this.selector)) {
            if (cand.contains(current) || current.contains(cand) || !this.visible(cand)) {
                continue;
            }
            if (outside?.contains(cand)) {
                continue;
            }
            const rect = this.clippedRect(cand);
            if (!rect) {
                continue;
            }
            const score = this.score(from, rect, direction);
            if (score < bestScore) {
                bestScore = score;
                best = cand;
            }
        }
        if (!best) {
            return null;
        }
        for (let p = this.focusableParent(best); p && !p.contains(current); ) {
            best = p;
            p = this.focusableParent(p);
        }
        return best;
    }

    // Distance from `from` to `to` in `direction`; Infinity unless `to` lies in
    // the beam that `from` projects in that direction (i.e. beyond its edge and
    // overlapping it on the cross axis), so the focus never moves diagonally.
    // Ties on distance go to the candidate best centred on the beam.
    private score(from: Rect, to: Rect, direction: Direction): number {
        const vertical = direction === "up" || direction === "down";
        let gap: number;
        if (vertical) {
            gap = direction === "up" ? from.top - to.bottom : to.top - from.bottom;
        } else {
            gap = direction === "left" ? from.left - to.right : to.left - from.right;
        }
        const [lo, hi, toLo, toHi] = vertical
            ? [from.left, from.right, to.left, to.right]
            : [from.top, from.bottom, to.top, to.bottom];
        const overlap = Math.min(hi, toHi) - Math.max(lo, toLo);
        if (gap < -TOLERANCE || overlap <= 0) {
            return Number.POSITIVE_INFINITY;
        }
        const offCentre = Math.abs((lo + hi) / 2 - (toLo + toHi) / 2);
        return Math.max(0, gap) + offCentre / 1000;
    }

    // The part of `el` not clipped away by scrolling/overflow ancestors, or null.
    private clippedRect(el: HTMLElement): Rect | null {
        const r = el.getBoundingClientRect();
        let { top, bottom, left, right } = r;
        for (let node = el.parentElement; node; node = node.parentElement) {
            const style = getComputedStyle(node);
            if (style.overflowX !== "visible" || style.overflowY !== "visible") {
                const c = node.getBoundingClientRect();
                top = Math.max(top, c.top);
                bottom = Math.min(bottom, c.bottom);
                left = Math.max(left, c.left);
                right = Math.min(right, c.right);
            }
        }
        if (bottom - top <= 0 || right - left <= 0) {
            return null;
        }
        return { top, bottom, left, right };
    }

    // ── Event handlers ──────────────────────────────────────────────────────

    private closestFocusable(target: EventTarget | null): HTMLElement | null {
        if (!(target instanceof Element) || target.closest(NOFOCUS)) {
            return null;
        }
        const el = target.closest<HTMLElement>(this.selector);
        return el && this.root.contains(el) ? el : null;
    }

    private onPointerDown = (e: PointerEvent): void => {
        const el = this.closestFocusable(e.target);
        if (el) {
            // No DOM focus change here: the click itself places it (e.g. the
            // cursor in an editor); focusing a container moves it to a leaf.
            const leaf = this.resolve(el);
            this.setCurrent(leaf, leaf !== el, "click");
        }
    };

    // Pressing a `nofocus` element must not move the DOM focus to it either;
    // cancelling mousedown prevents that (the click still happens).
    private onMouseDown = (e: MouseEvent): void => {
        if (e.target instanceof Element && e.target.closest(NOFOCUS)) {
            e.preventDefault();
        }
    };

    // The only trace of a click inside an iframe: the page loses the focus to
    // it. (The window also blurs when the whole browser window does, but then
    // the active element isn't an iframe that just got the focus.)
    private onWindowBlur = (): void => {
        const active = document.activeElement;
        if (!(active instanceof HTMLIFrameElement)) {
            return;
        }
        const el = this.closestFocusable(active);
        if (el && !el.contains(this.currentEl)) {
            this.setCurrent(this.resolve(el), false, "click");
        }
    };

    // Deferred to a microtask, so the requester can finish setting up the new
    // content (e.g. size a terminal) before the focus moves into it.
    private onCommitRequest = (e: Event): void => {
        const target = e.target;
        queueMicrotask(() => {
            const current = this.current;
            if (
                current &&
                target instanceof Node &&
                current.contains(target) &&
                !this.holdCommits
            ) {
                this.commitFocus();
            }
        });
    };

    private onFocusIn = (e: FocusEvent): void => {
        const el = this.closestFocusable(e.target);
        if (el && !el.contains(this.currentEl)) {
            const leaf = this.resolve(el);
            this.setCurrent(leaf, leaf !== el, "dom");
        }
    };
}
