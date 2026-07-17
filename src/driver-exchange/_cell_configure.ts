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
    const entry = buche.ensure(obj);
    const zone = buche.findPlace(entry, obj);
    if (entry.cell) {
        entry.cell.configure(obj);
    } else {
        const cell = new Cell(obj);
        entry.setCell(cell);
    }
    entry.echo.status = { status: "running" };
    buche.sendInterface({
        type: "update_cell",
        zone: zone,
        entry: entry,
    });
}
