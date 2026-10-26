import type { Cell } from "./cell";
import { Echo, type Status } from "./echo";
import type { Prompt } from "./prompt";
import type { Address, Target } from "./types";
import { Hierarchy, type HierarchyArgs } from "./utils";

/** The field of a placeholder entry, under the entry it stands in for. */
export const PLACEHOLDER = "?";

export class Entry extends Hierarchy {
    echo: Echo;
    cell: Cell | null = null;
    prompt: Prompt | null = null;
    /** Where this entry's cell or prompt was asked to go (null: not shown). */
    target: Target | null = null;
    /**
     * The entry showing this one (a configured process): its placeholder,
     * then whatever claimed it. Later children go beside it.
     */
    primary: Entry | null = null;
    /** An unclaimed placeholder (see `Buche.claim`). */
    placeholder = false;
    /**
     * The address of the entry this one stands for (set by `cell_configure`).
     * While set, the entry's status mirrors the represented entry's, and user
     * interactions (signal, input, resize) are routed to its address.
     */
    represents: Address | null = null;

    /** Listeners */
    listeners: Array<(entry: this) => void> = [];

    constructor(args: HierarchyArgs) {
        super(args);
        this.echo = new Echo({
            from: this.address(),
            color: this.parent?.echo.color,
        });
    }

    setEcho(echo: Echo) {
        this.echo = echo;
    }

    setCell(cell: Cell) {
        this.cell = cell;
    }

    setPrompt(prompt: Prompt) {
        this.prompt = prompt;
    }

    /** Whether it shows something: a cell or a prompt. */
    get visual(): boolean {
        return this.cell !== null || this.prompt !== null;
    }

    /** Move to another field of the same parent (a placeholder being claimed). */
    rename(field: string): void {
        const parent = this.parent!;
        delete parent.children[this.field!];
        parent.children[field] = this;
        this.field = field;
        this.echo.address = this.address();
    }

    /**
     * The entry named by {@link Entry.represents}, resolved from the root of
     * the hierarchy; null when `represents` is unset or names no existing
     * entry.
     */
    representative(): Entry | null {
        if (this.represents === null) {
            return null;
        }
        let root: Entry = this;
        while (root.parent) {
            root = root.parent;
        }
        return root.getAt(this.represents);
    }

    fire() {
        for (const listener of this.listeners) {
            listener(this);
        }
    }

    toJSON() {
        const json: Record<string, unknown> = {
            echo: this.echo,
            cell: this.cell,
            prompt: this.prompt,
        };
        if (this.represents !== null) {
            json.represents = this.represents;
        }
        return json;
    }
}

/**
 * The status an entry displays: its represented entry's when it represents a
 * live one (the represented entry is the process; the cell or prompt is its
 * handle), its own otherwise — including when `represents` names no existing
 * entry or an entry nothing ever configured (status `absent`), which means
 * there is no process to mirror yet.
 */
export function statusOf(entry: Entry): Status {
    const rep = entry.representative();
    if (rep === null || rep.echo.status.status === "absent") {
        return entry.echo.status;
    }
    return rep.echo.status;
}
