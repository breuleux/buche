import { Prompt } from "./prompt.ts";

export interface CellConfiguration {
  /** The cell/tab label. */
  label?: string | null;

  /** Toggle whether the cell keeps or relinquishes focus when it is closed. */
  sticky?: boolean;

  /** If true, do not automatically focus the cell. */
  background?: boolean;
}

export class Cell implements CellConfiguration {
    prompt?: Prompt;

    label?: string | null;
    sticky?: boolean;
    background?: boolean;

    constructor(config: CellConfiguration) {
        this.configure(config);
    }
    configure(config: CellConfiguration) {
        Object.assign(this, config);
    }
}
