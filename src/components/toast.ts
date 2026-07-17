// Closable notification toasts, stacked at the top-right corner of the window.
// Unlike the other components these are not placed in a zone: one fixed stack
// lives on the document body, and callers push messages into it with
// `showToast`.
//
//   import { showToast } from "./components/toast.ts";
//   showToast("something went wrong");
//
// Appearance lives in the companion stylesheet `toast.css` (or the
// consolidated components.css).

let stack: HTMLElement | null = null;

function ensureStack(): HTMLElement {
    if (!stack?.isConnected) {
        stack = document.createElement("div");
        stack.className = "buche-toast-stack";
        document.body.append(stack);
    }
    return stack;
}

/** Append a closable toast carrying `message` to the top-right stack, and
 *  return its element (removing the element dismisses the toast). */
export function showToast(message: string): HTMLElement {
    const item = document.createElement("div");
    item.className = "buche-toast";

    const text = document.createElement("div");
    text.className = "buche-toast-text";
    text.textContent = message;

    const close = document.createElement("button");
    close.type = "button";
    close.className = "buche-toast-close";
    close.textContent = "✕";
    close.title = "Dismiss";
    close.addEventListener("click", () => item.remove());

    item.append(text, close);
    ensureStack().append(item);
    return item;
}
