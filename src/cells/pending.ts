import { Cell } from "../cell.ts";
import type { EchoBox } from "../components/echo-box.tsx";
import type { Entry } from "../entry.ts";
import { ensureTerminal } from "./terminal.ts";

/**
 * A placeholder: the cell of a configured entry's `?`, standing in for
 * whatever the entry shows first, which takes it over (see `Buche.claim`) and
 * replaces it. Meanwhile it has a terminal, to take input (typing into it
 * makes it the process's `$stdout`); it takes no commands.
 */
export class PendingCell extends Cell {
    readonly kind = "pending";

    initialize(entry: Entry, box: EchoBox): void {
        ensureTerminal(entry, box);
    }

    /** Clear the terminal (what was typed into it, say). */
    reset(entry: Entry, box: EchoBox, focus: boolean): void {
        ensureTerminal(entry, box).reset();
    }
}
