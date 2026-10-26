// What to put in an empty slot (a new tab, an empty pane), as a custom
// element: `<slot-chooser>`. A list of options, then a field to type a
// command in, driven by the keyboard:
//
//   ↑ / ↓       move the highlight (↓ past the last option: the field)
//   1…9         pick that option        Enter   pick the highlighted one
//   a letter    starts typing in the field (Enter runs it: `setCommand`)
//   Esc         cancel (`oncancel`); in the field, back to the list
//
// Clicking an option picks it too. `setMessage` replaces everything with a
// line of text; Esc still cancels.

export interface SlotOption {
    label: string;
    pick(): void;
}

export class SlotChooser extends HTMLElement {
    private options: SlotOption[] = [];
    private index = 0;
    private list = document.createElement("div");
    private field = document.createElement("input");
    private message = document.createElement("div");
    /** What Enter in the field does with its text. */
    private command: { placeholder: string; run(text: string): void } | null = null;
    /** Cancelled (Esc, from the list or a message). */
    oncancel: (() => void) | null = null;

    constructor() {
        super();
        this.tabIndex = 0;
        // A focusable of its own (focus.ts), taking the keyboard focus when
        // navigated onto, or pressed (a re-render on the press, moving a
        // focused editor elsewhere, would take it back otherwise).
        this.setAttribute("focusable", "slot");
        this.addEventListener("pointerdown", () => {
            requestAnimationFrame(() => {
                if (!this.contains(document.activeElement)) {
                    this.focus({ preventScroll: true });
                }
            });
        });
        this.list.className = "slot-chooser-list";
        this.field.className = "slot-chooser-field";
        this.field.spellcheck = false;
        this.message.className = "slot-chooser-message";
        this.message.hidden = true;
        this.append(this.list, this.field, this.message);
        this.addEventListener("keydown", (e) => this.onKey(e));
        this.field.addEventListener("keydown", (e) => this.onFieldKey(e));
        this.field.addEventListener("focus", () => this.highlight());
        this.field.addEventListener("blur", () => this.highlight());
        this.syncField();
    }

    /** Take the keyboard focus (focus.ts: committing a focus on it). */
    commitFocus(): void {
        if (!this.contains(document.activeElement)) {
            this.focus({ preventScroll: true });
        }
    }

    setOptions(options: SlotOption[]): void {
        this.options = options;
        this.index = 0;
        this.list.replaceChildren(
            ...options.map((option, i) => {
                const row = document.createElement("div");
                row.className = "slot-chooser-option";
                row.textContent = `${i + 1}  ${option.label}`;
                row.addEventListener("pointerdown", (e) => e.preventDefault());
                row.addEventListener("click", () => this.choose(i));
                return row;
            }),
        );
        this.highlight();
    }

    /** The field: Enter runs what was typed in it. */
    setCommand(placeholder: string, run: (text: string) => void): void {
        this.command = { placeholder, run };
        this.syncField();
    }

    /** Show a line of text instead of the options. */
    setMessage(text: string): void {
        this.message.textContent = text;
        this.message.hidden = false;
        this.list.hidden = true;
        this.field.hidden = true;
        this.focus({ preventScroll: true });
    }

    private syncField(): void {
        this.field.hidden = !this.command;
        this.field.placeholder = this.command?.placeholder ?? "";
    }

    private highlight(): void {
        const inField = document.activeElement === this.field;
        [...this.list.children].forEach((row, i) => {
            row.classList.toggle("active", !inField && i === this.index);
        });
    }

    private choose(i: number): void {
        const option = this.options[i];
        if (!option) {
            return;
        }
        this.index = i;
        this.highlight();
        option.pick();
    }

    /** Back to the list, out of the field. */
    private back(): void {
        this.field.value = "";
        this.focus({ preventScroll: true });
        this.highlight();
    }

    private onKey(e: KeyboardEvent): void {
        if (e.target === this.field || e.altKey || e.ctrlKey || e.metaKey) {
            return;
        }
        const n = this.options.length;
        let handled = true;
        if (e.key === "Escape") {
            this.oncancel?.();
        } else if (!this.message.hidden) {
            handled = false;
        } else if (e.key === "ArrowDown" && n) {
            if (this.index === n - 1 && !this.field.hidden) {
                this.field.focus({ preventScroll: true });
            } else {
                this.index = (this.index + 1) % n;
                this.highlight();
            }
        } else if (e.key === "ArrowUp" && n) {
            this.index = (this.index + n - 1) % n;
            this.highlight();
        } else if (e.key === "Enter") {
            this.choose(this.index);
        } else if (/^[1-9]$/.test(e.key)) {
            this.choose(Number(e.key) - 1);
        } else if (e.key.length === 1 && e.key !== " " && this.command && !this.field.hidden) {
            // Typing: into the field.
            this.field.focus({ preventScroll: true });
            this.field.value += e.key;
        } else {
            handled = false;
        }
        if (handled) {
            e.preventDefault();
            e.stopPropagation();
        }
    }

    private onFieldKey(e: KeyboardEvent): void {
        const text = this.field.value.trim();
        if (e.key === "Enter" && text) {
            e.preventDefault();
            this.command?.run(text);
        } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            this.back();
        } else if (e.key === "ArrowUp" && this.field.selectionStart === 0) {
            e.preventDefault();
            this.back();
        }
    }
}

if (typeof customElements !== "undefined" && !customElements.get("slot-chooser")) {
    customElements.define("slot-chooser", SlotChooser);
}
