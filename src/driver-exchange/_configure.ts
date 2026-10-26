import type { Buche } from "../core.ts";
import type { EchoConfiguration } from "../echo.ts";
import type { BaseMessage, CreationInfo } from "./common.ts";

/**
 * Declares (or reconfigures) an entry: a process, or any non-visual parent of
 * cells and prompts. It carries the shared echo configuration (label, color,
 * `represents`, `ephemeral`, ...), which the entry's views show too, and says
 * where the entry goes: the first time, it gets a placeholder (`<from>.?`), an
 * empty cell placed in `zone` that stands in for the first cell or prompt the
 * entry shows (see `Buche.claim`), and takes its input meanwhile.
 */
export interface ConfigureMessage extends BaseMessage, CreationInfo, EchoConfiguration {
    type: "configure";
}

export function handle$configure(buche: Buche, obj: ConfigureMessage): void {
    const fresh = buche.hierarchy.getAt(obj.from, false) === null;
    const entry = buche.ensure(obj);
    if (!fresh) {
        buche.relook(entry, obj);
    }
    // Declaring a process marks it running; reconfiguring one that has
    // already started (or ended) leaves its status alone.
    if (entry.echo.status.status === "absent") {
        entry.echo.status = { status: obj.status ?? "running" };
    }
    // A reconfiguration does not move anything: the placeholder is made once.
    buche.ensurePlaceholder(entry, obj.zone);
}
