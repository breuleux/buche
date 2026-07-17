import { Cell, type CellConfiguration } from "../cell.ts";
import type { Buche, OutM } from "../core.ts";
import type { BaseMessage, CreationInfo } from "./common.ts";

export interface CellCreateMessage extends BaseMessage, CreationInfo, CellConfiguration {
    type: "cell_create";
}

export async function* handle$cell_create(
    buche: Buche,
    obj: CellCreateMessage,
): AsyncIterable<OutM> {
    const component = buche.fresh(obj.from);
    const { prompt, zone } = buche.findPlace(obj);
    const cell = new Cell(obj, zone);
    cell.prompt = prompt;
    cell.zone = zone;
    Object.assign(component, { cell, zones: cell.makeZones() });
    yield {
        type: "install_cell",
        zone: zone,
        component: component,
    };
}
