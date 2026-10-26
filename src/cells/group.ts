import { Cell } from "../cell.ts";

/**
 * The cell of an entry that shows nothing itself: a process, or any parent of
 * cells. Its look and status are what its views take on. Every entry starts
 * with one.
 */
export class GroupCell extends Cell {
    readonly kind = "group";
}
