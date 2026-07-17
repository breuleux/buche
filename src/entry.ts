import type { Cell } from "./cell";
import { Echo, type Status } from "./echo";
import type { Prompt } from "./prompt";
import type { Address } from "./types";
import { Hierarchy, type HierarchyArgs } from "./utils";
import { type Zone, zoneMap } from "./zone";

interface EntryArgs extends HierarchyArgs {
    zones?: Record<string, Zone>;
}

export class Entry extends Hierarchy {
    echo: Echo;
    cell: Cell | null = null;
    prompt: Prompt | null = null;
    /** Zones this entry defines (e.g. its prompt's "@") or inherits, by name. */
    zones: Record<string, Zone> = {};
    /**
     * The address of the entry this one stands for (set by `cell_configure`).
     * While set, the entry's status mirrors the represented entry's, and user
     * interactions (signal, input, resize) are routed to its address.
     */
    represents: Address | null = null;

    /** Listeners */
    listeners: Array<(entry: this) => void> = [];

    constructor(args: EntryArgs) {
        super(args);
        this.echo = new Echo({
            from: this.address(),
            color: this.parent?.echo.color,
        });
        this.zones = args.zones ?? {};
    }

    setEcho(echo: Echo) {
        this.echo = echo;
    }

    setCell(cell: Cell) {
        this.cell = cell;
        Object.assign(this.zones, zoneMap(Object.values(cell.zones)));
    }

    setPrompt(prompt: Prompt) {
        this.prompt = prompt;
        Object.assign(this.zones, zoneMap(Object.values(prompt.zones)));
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
            zones: this.zones,
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
