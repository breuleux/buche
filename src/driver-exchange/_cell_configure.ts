import { Cell, type CellConfiguration } from "../cell.ts";
import type { Buche } from "../core.ts";
import type { EchoConfiguration } from "../echo.ts";
import type { BaseMessage, CreationInfo } from "./common.ts";

export interface CellConfigureMessage
    extends BaseMessage,
        CreationInfo,
        EchoConfiguration,
        CellConfiguration {
    type: "cell_configure";
}

export function handle$cell_configure(buche: Buche, obj: CellConfigureMessage): void {
    buche.claim(obj.from, "cell");
    const entry = buche.ensure(obj);
    // A reconfiguration (or a claimed placeholder) stays where it is.
    let target = null;
    if (entry.cell) {
        entry.cell.configure(obj);
    } else {
        entry.setCell(new Cell(obj));
        target = entry.target = buche.targetFor(entry, obj.zone, "cell");
    }
    if (obj.status === undefined || entry.representative() !== null) {
        entry.echo.status = { status: "running" };
    }
    buche.sendInterface({
        type: "update_cell",
        target,
        entry: entry,
    });
}
