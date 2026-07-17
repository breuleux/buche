import type { Buche } from "../core.ts";
import type { EchoConfiguration } from "../echo.ts";
import type { BaseMessage, CreationInfo } from "./common.ts";

/**
 * Declares (or reconfigures) an entry without installing anything in any
 * zone: a process, or any non-visual parent of cells and prompts. It carries
 * the shared echo configuration (label, color, `represents`, `ephemeral`,
 * ...) — applied without creating a cell, so it can retune an entry that
 * already has one, or state things about one that doesn't — and records its
 * placement: descendants resolve their zones through this entry (an unnamed
 * request gets the configured zone, recorded under `""`; a named one matches
 * the configured zone's own names; `origin` names the zone an unnamed request
 * would have resolved to anyway, typically the spawning prompt).
 */
export interface ConfigureMessage extends BaseMessage, CreationInfo, EchoConfiguration {
    type: "configure";
}

export function handle$configure(buche: Buche, obj: ConfigureMessage): void {
    const entry = buche.ensure(obj);
    // Where an unnamed request would resolve — the origin.
    const origin = buche.findPlace(entry, { from: obj.from, zone: null });
    const zone = obj.zone ? buche.findPlace(entry, obj) : origin;
    // A reconfiguration does not move anything: keys set by a previous
    // `configure` win.
    entry.zones[""] ??= zone;
    entry.zones.origin ??= origin;
    for (const name of zone.names) {
        entry.zones[name] ??= zone;
    }
    // Declaring a process marks it running; reconfiguring one that has
    // already started (or ended) leaves its status alone.
    if (entry.echo.status.status === "absent") {
        entry.echo.status = { status: "running" };
    }
}
