// Focus tracking over elements tagged `focusable`. (Moving the focus around is
// the layout's: see carreau's keyboard navigation.)
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
//       "nav"      keyboard navigation (the layout's)
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
    /**
     * The focused element was removed or hidden: where the focus goes is up
     * to this, if given (e.g. a layout engine that knows where it belongs).
     * Returns whether it took care of it; otherwise, the focus goes back in
     * the history.
     */
    onLost?: (element: HTMLElement) => boolean;
}

// Native elements that should receive DOM focus when their focusable is focused.
const EDITABLE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';

// Elements whose clicks don't change the focus.
const NOFOCUS = "[nofocus]";

export class FocusManager {
    readonly root: HTMLElement;
    private readonly attribute: string;
    private readonly selector: string;
    private readonly historySize: number;
    private readonly onLost?: (element: HTMLElement) => boolean;

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
        this.onLost = options.onLost;

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

    /** Focus `el`, then commit it — unless commits are held (a navigation
     *  is going on, which commits when it ends). */
    focusAndCommit(el: HTMLElement, source: FocusSource = "api"): void {
        this.focus(el, source);
        if (!this.holdCommits) {
            this.commitFocus();
        }
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
     * one) that is still there, visible, and not the current one's container,
     * as when the focused element is removed; then commit, unless commits are
     * held. Returns whether the focus moved.
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

    // The most recent valid element of the history other than the current one,
    // and that does not resolve back to it: stepping onto the container of the
    // current leaf (e.g. a cell's box, when the focus is on something inside
    // it) would not move the focus anywhere.
    private previousValid(): HTMLElement | null {
        for (let i = this.past.length - 1; i >= 0; i--) {
            const el = this.past[i].element;
            if (el !== this.currentEl && this.valid(el)) {
                const leaf = this.resolve(el);
                if (leaf !== this.currentEl && this.valid(leaf)) {
                    return el;
                }
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
        if (this.onLost?.(current)) {
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
    // content (e.g. size a terminal) before the focus moves into it. Requests
    // arriving in the same task coalesce into a single commit.
    private commitRequests = new Set<Node>();
    private commitPending = false;
    private onCommitRequest = (e: Event): void => {
        if (e.target instanceof Node) {
            this.commitRequests.add(e.target);
        }
        if (this.commitPending) {
            return;
        }
        this.commitPending = true;
        queueMicrotask(() => {
            this.commitPending = false;
            const wanted = [...this.commitRequests];
            this.commitRequests.clear();
            const current = this.current;
            if (!current || this.holdCommits) {
                return;
            }
            if (wanted.some((t) => current.contains(t))) {
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
