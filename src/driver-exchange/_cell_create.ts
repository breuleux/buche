import { Buche, CellConfiguration } from "../core.ts";
import { BaseMessage, ZoneDescriptor } from "./common.ts";

export interface CellCreateMessage extends BaseMessage, CellConfiguration {
  type: "cell_create";

  /** Which cell handler to instantiate. Unknown modes are ignored with an error. */
  mode: string;

  /** Associates the cell with an existing prompt. */
  prompt_id?: string | null;

  /** Which zone to put the cell in. */
  zone?: ZoneDescriptor | null;
}

export async function handle$cell_create(
    buche: Buche,
    obj: CellCreateMessage
): Promise<void> {
    const ctor = buche.cellTypes[obj.mode];
    if (!ctor) {
        throw Error(`Unsupported cell type: '${obj.mode}'`);
    }
    const cell = new ctor(obj);
    const key = JSON.stringify(obj.from);
    if (key in buche.cells) {
        throw Error(`Cell already exists at address ${obj.from}`);
    }
    buche.cells[key] = cell;
}
