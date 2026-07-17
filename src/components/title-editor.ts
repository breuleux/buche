// A small popup to rename the window (bound to C-q-t by the interface): one
// input prefilled with the current title — Enter applies, Esc or a click
// outside cancels. The document title is always updated; in Electron the title
// is also pushed to the window itself through the preload bridge
// (`window.buche.window.setTitle`, see electron/preload.ts and main.ts).
//
// Appearance lives in the companion stylesheet `title-editor.css` (or the
// consolidated components.css).

interface TitleBridge {
    window?: { setTitle?: (title: string) => void };
}

let popup: HTMLElement | null = null;
// Called when the popup closes, however it closed (applied, cancelled,
// replaced) — the interface uses it to give the focus back.
let onDone: (() => void) | null = null;

function dismiss(): void {
    popup?.remove();
    popup = null;
    const done = onDone;
    onDone = null;
    done?.();
}

/** Open the popup (any one already open is replaced) and return its element.
 *  `done` runs when the popup closes. */
export function showTitleEditor(done?: () => void): HTMLElement {
    dismiss();
    onDone = done ?? null;

    const overlay = document.createElement("div");
    overlay.className = "buche-title-overlay";

    const box = document.createElement("div");
    box.className = "buche-title-editor";

    const input = document.createElement("input");
    input.type = "text";
    input.className = "buche-title-input";
    input.value = document.title;
    input.spellcheck = false;
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            // dismiss() hands the focus back (to a prompt's editor, say) in
            // the middle of this keydown: without preventDefault, the Enter's
            // default insertion would land in the newly focused element.
            e.preventDefault();
            const title = input.value.trim();
            if (title !== "") {
                document.title = title;
                const bridge = (window as unknown as { buche?: TitleBridge }).buche;
                bridge?.window?.setTitle?.(title);
            }
            dismiss();
        } else if (e.key === "Escape") {
            dismiss();
        }
    });

    const hint = document.createElement("div");
    hint.className = "buche-title-hint";
    hint.textContent = "Window title — Enter to apply, Esc to cancel";

    overlay.addEventListener("pointerdown", (e) => {
        if (e.target === overlay) {
            dismiss();
        }
    });

    box.append(input, hint);
    overlay.append(box);
    document.body.append(overlay);
    popup = overlay;
    requestAnimationFrame(() => {
        input.focus();
        input.select();
    });
    return overlay;
}

/** Give the input back its DOM focus if the popup is open. Called when capture
 *  mode ends: releasing Ctrl commits the focus, which can pull the DOM focus
 *  into a cell's terminal or a prompt editor (see the interface's keys). */
export function refocusTitleEditor(): void {
    if (popup === null) {
        return;
    }
    const input = popup.querySelector("input");
    if (input) {
        requestAnimationFrame(() => input.focus());
    }
}
