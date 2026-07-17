import { Buche } from "../core.ts";
import { CellConfiguration } from "./_cell_configure.ts";
import { BaseMessage, ZoneDescriptor } from "./common.ts";

export type CellMode = "text" | "term" | "auto" | "data";

export interface CellCreateMessage extends BaseMessage, CellConfiguration {
  type: "cell_create";

  /** Which cell handler to instantiate. Unknown modes are ignored with an error. */
  mode: CellMode;

  /** Associates the cell with an existing prompt. */
  prompt_id?: string | null;

  /** Which handler to instantiate. Unknown modes are ignored with an error. */
  zone?: ZoneDescriptor;

  /** Inline HTML echo of the command line, shown in the cell header. */
  echo_html?: string | null;
}

export async function handle$cell_create(
    buche: Buche,
    obj: CellCreateMessage
): Promise<void> {

}
