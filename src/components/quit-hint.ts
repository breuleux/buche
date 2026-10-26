// The hint shown in the middle of the window while Cmd+Q is held: quitting
// takes holding it (see `guardQuit` in electron/main.ts, which sends
// `window:quitHint` messages through the preload). A bar fills up over the
// hold; letting go early hides the hint.
//
//   showQuitHint(1000);  // the hold started: quits after 1000 ms
//   hideQuitHint();      // let go early
//
// Appearance lives in the companion stylesheet `quit-hint.css`.

let hint: HTMLElement | null = null;

/** Show the hint, its bar filling up over `duration` ms. */
export function showQuitHint(duration: number): void {
    hideQuitHint();
    const isMac = navigator.platform.toLowerCase().includes("mac");
    hint = document.createElement("div");
    hint.className = "buche-quit-hint";
    const text = document.createElement("div");
    text.className = "buche-quit-hint-text";
    text.textContent = `Hold ${isMac ? "⌘Q" : "Ctrl+Q"} to quit`;
    const bar = document.createElement("div");
    bar.className = "buche-quit-hint-bar";
    bar.style.animationDuration = `${duration}ms`;
    hint.append(text, bar);
    document.body.append(hint);
}

export function hideQuitHint(): void {
    hint?.remove();
    hint = null;
}

/** Follow the `window:quitHint` messages posted by the Electron preload. */
export function listenQuitHint(): void {
    window.addEventListener("message", (event) => {
        const d = event.data as { __buche?: string; state?: string; duration?: number } | null;
        if (d?.__buche !== "window:quitHint") {
            return;
        }
        if (d.state === "start") {
            showQuitHint(d.duration ?? 1000);
        } else {
            hideQuitHint();
        }
    });
}
