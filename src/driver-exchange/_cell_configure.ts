import { type CellConfiguration } from "../cell.ts";
import { type Buche } from "../core.ts";
import { type BaseMessage } from "./common.ts";

export interface CellConfigureMessage extends BaseMessage, CellConfiguration {
  type: "cell_configure";
}

export async function handle$cell_configure(
    buche: Buche,
    obj: CellConfigureMessage
): Promise<void> {
    const key = JSON.stringify(obj.from);
    const cell = buche.cells[key];
    if (!cell) {
        throw Error(`No cell to configure at address: ${key}`);
    }
    cell.configure(obj);
}
