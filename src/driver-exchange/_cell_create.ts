import type { CellConfiguration } from "../cell.ts";
import type { Buche, OutM } from "../core.ts";
import type { BaseMessage, CreationInfo } from "./common.ts";

export interface CellCreateMessage extends BaseMessage, CreationInfo, CellConfiguration {
    type: "cell_create";
}

export async function* handle$cell_create(
    buche: Buche,
    obj: CellCreateMessage,
): AsyncIterable<OutM> {
    yield* buche.create("cell", obj);
}
