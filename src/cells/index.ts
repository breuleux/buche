import type { Cell, CellKind } from "../cell.ts";
import { FrameCell } from "./frame.ts";
import { GroupCell } from "./group.ts";
import { PendingCell } from "./pending.ts";
import { PromptCell } from "./prompt.ts";
import { TerminalCell } from "./terminal.ts";

export { FrameCell, GroupCell, PendingCell, PromptCell, TerminalCell };

/** A new (blank) cell of `kind`. */
export function makeCell(kind: CellKind): Cell {
    switch (kind) {
        case "group":
            return new GroupCell();
        case "pending":
            return new PendingCell();
        case "terminal":
            return new TerminalCell();
        case "frame":
            return new FrameCell();
        case "prompt":
            return new PromptCell();
    }
}
