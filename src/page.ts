// What the pages (electron/renderer.ts, scripts/view-client.ts) share: where
// the interface goes, and the layout it starts with.

import type { WorkspaceData } from "carreau/src/types";

/**
 * The #buche container and the initial layout, given by the page as JSON in a
 * `<script type="application/json" id="buche-layout">` (absent: the default).
 */
export function pageSetup(): { container: HTMLElement; layout?: WorkspaceData } {
    const container = document.getElementById("buche");
    if (!container) {
        throw new Error("buche: the #buche container is missing");
    }
    const json = document.getElementById("buche-layout")?.textContent?.trim();
    return { container, layout: json ? (JSON.parse(json) as WorkspaceData) : undefined };
}

/** The page markup for a layout file's content (JSON), safe inside a script tag. */
export function layoutScript(json: string | null): string {
    return json
        ? `<script type="application/json" id="buche-layout">${json.replace(/</g, "\\u003c")}</script>`
        : "";
}
