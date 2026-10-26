// What the pages (electron/renderer.ts, scripts/view-client.ts) share: where
// the interface goes, the layout it starts with, and the configuration.

import type { WorkspaceData } from "carreau";
import type { BucheConfig } from "./config.ts";

/** The JSON content of a `<script type="application/json">` of the page. */
function pageJson<T>(id: string): T | undefined {
    const json = document.getElementById(id)?.textContent?.trim();
    return json ? (JSON.parse(json) as T) : undefined;
}

/**
 * The #buche container, the initial layout and the configuration (the
 * user's, and the defaults it goes over), given by the page as JSON in
 * `<script type="application/json">` tags (#buche-layout, #buche-config,
 * #buche-default-config; absent: the defaults).
 */
export function pageSetup(): {
    container: HTMLElement;
    layout?: WorkspaceData;
    config?: BucheConfig;
    defaultConfig?: BucheConfig;
} {
    const container = document.getElementById("buche");
    if (!container) {
        throw new Error("buche: the #buche container is missing");
    }
    return {
        container,
        layout: pageJson<WorkspaceData>("buche-layout"),
        config: pageJson<BucheConfig>("buche-config"),
        defaultConfig: pageJson<BucheConfig>("buche-default-config"),
    };
}

/** A JSON script tag with this content, safe inside the page. */
function jsonScript(id: string, json: string): string {
    return `<script type="application/json" id="${id}">${json.replace(/</g, "\\u003c")}</script>`;
}

/** The page markup for a layout file's content (JSON). */
export function layoutScript(json: string | null): string {
    return json ? jsonScript("buche-layout", json) : "";
}

/** The page markup for the configuration: the user's, over the defaults. */
export function configScript(config: { user: BucheConfig; defaults: BucheConfig }): string {
    return [
        jsonScript("buche-default-config", JSON.stringify(config.defaults)),
        jsonScript("buche-config", JSON.stringify(config.user)),
    ].join("\n");
}
