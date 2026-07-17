import type { CellConfiguration } from "../cell.ts";
import type { Buche, OutM } from "../core.ts";
import type { BaseMessage, CreationInfo } from "./common.ts";

export interface CellConfigureMessage extends BaseMessage, CreationInfo, CellConfiguration {
    type: "cell_configure";
}

export async function* handle$cell_configure(
    buche: Buche,
    obj: CellConfigureMessage,
): AsyncIterable<OutM> {
    yield* buche.configure("cell", obj);
}
