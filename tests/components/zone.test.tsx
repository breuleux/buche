// @vitest-environment happy-dom

import { afterEach, describe, expect, test } from "vitest";
import type { TabbedZoneElement } from "../../src/components/zone.tsx";
import "../../src/components/zone.tsx";
import { Entry } from "../../src/entry.ts";

afterEach(() => {
    document.body.replaceChildren();
});

describe("tabbed-zone — emptiness", () => {
    test("an empty zone is hidden; a tab shows it again", () => {
        const zone = document.createElement("tabbed-zone") as TabbedZoneElement;
        document.body.appendChild(zone);
        expect(zone.hidden).toBe(true);

        const entry = new Entry({});
        entry.echo.label = "a";
        zone.tabs.addTab(entry, document.createElement("div"));
        expect(zone.hidden).toBe(false);

        zone.tabs.removeTab(entry);
        expect(zone.hidden).toBe(true);
    });
});
