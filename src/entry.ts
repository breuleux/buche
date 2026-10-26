import { type Cell, type CellKind, isSpent } from "./cell";
import { GroupCell, makeCell } from "./cells/index.ts";
import type { Target } from "./types";
import { Hierarchy, type HierarchyArgs } from "./utils";

/** The field of a placeholder entry, under the entry it stands in for. */
export const PLACEHOLDER = "?";

export class Entry extends Hierarchy {
    /** Its look and status, and what it shows: nothing yet (a group, such as
     *  a process), a placeholder, a terminal, a GUI or a prompt (see
     *  {@link CellKind}). */
    cell: Cell;
    /** Where this entry's cell was asked to go (null: not shown). */
    target: Target | null = null;
    /**
     * The entry showing this one (a configured process): its placeholder,
     * then whatever claimed it. Later children go beside it.
     */
    primary: Entry | null = null;
    /** Listeners */
    listeners: Array<(entry: this) => void> = [];

    constructor(args: HierarchyArgs) {
        super(args);
        // Until told otherwise, an entry looks like the one it is under (a
        // process's views look like it) — except at the top, which has no look
        // of its own to give.
        const parent = this.parent;
        const look = parent?.parent
            ? { label: parent.cell.label, color: parent.cell.color, icon: parent.cell.icon }
            : { color: parent?.cell.color };
        this.cell = new GroupCell(look);
    }

    /** Give the entry a new cell of `kind` (it shows something else now: a
     *  group or a placeholder becoming what it shows). The new cell takes
     *  over the look and status of the one it replaces. */
    replaceCell(kind: CellKind): Cell {
        this.cell = makeCell(kind).inherit(this.cell);
        return this.cell;
    }

    /** Whether it shows something. */
    get visual(): boolean {
        return this.cell.kind !== "group";
    }

    /** Move to another field of the same parent (a placeholder being claimed). */
    rename(field: string): void {
        const parent = this.parent!;
        delete parent.children[this.field!];
        parent.children[field] = this;
        this.field = field;
    }

    fire() {
        for (const listener of this.listeners) {
            listener(this);
        }
    }

    toJSON() {
        return { cell: this.cell };
    }
}

/**
 * Where signalling `entry` (its ✕) goes next: the group above it (a process,
 * which shows nothing itself; not the root), once everything else under that
 * group is signalled or spent — closing a process's last view ends the
 * process. Null when the signal stops at `entry`.
 */
export function bubblesTo(entry: Entry): Entry | null {
    const group = entry.parent;
    if (!group?.parent || group.visual || isSpent(group.cell.status.status)) {
        return null;
    }
    const others = Object.values(group.children).filter((child) => child !== entry);
    const done = others.every((child) => {
        const { status } = child.cell.status;
        return status === "unresponsive" || isSpent(status);
    });
    return done ? group : null;
}
