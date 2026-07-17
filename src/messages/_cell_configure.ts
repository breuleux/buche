import { Buche } from "../core.ts";
import { BaseMessage } from "./common.ts";

export interface CellConfiguration {
  /** The cell/tab label. */
  label?: string | null;

  /** Toggle whether the cell persists after its process closes. */
  sticky?: boolean;

  /** If true, unfocus the cell and return focus to its zone. */
  background?: boolean;
}

export interface CellConfigureMessage extends BaseMessage, CellConfiguration {
  type: "cell_configure";
}

export async function handle$cell_configure(
    buche: Buche,
    obj: CellConfigureMessage
): Promise<void> {

}
