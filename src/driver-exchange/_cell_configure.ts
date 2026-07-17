import type { CellConfiguration } from "../cell.ts";
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
    buche.configure("cell", obj);
}
