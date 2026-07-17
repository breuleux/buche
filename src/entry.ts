import type { Cell } from "./cell";
import { Echo } from "./echo";
import type { Prompt } from "./prompt";
import { Hierarchy, type HierarchyArgs } from "./utils";
import { type Zone, zoneMap } from "./zone";

interface EntryArgs extends HierarchyArgs {
    zones?: Record<string, Zone>;
}

export class Entry extends Hierarchy {
    echo: Echo;
    cell: Cell | null = null;
    prompt: Prompt | null = null;
    /** Zones this entry defines (e.g. its prompt's "@"), by name. */
    zones: Record<string, Zone> = {};
    /**
     * The zone this entry's prompt or cell was placed in, if any. Zone lookups
     * from its descendants consider that zone's names too (see
     * Buche.findPlace), so that e.g. a sub-shell living in some zone finds
     * the zones there before those elsewhere.
     */
    placement: Zone | null = null; // INELEGANCE: I would like all this logic to be in zone

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

    fire() {
        for (const listener of this.listeners) {
            listener(this);
        }
    }

    toJSON() {
        return {
            echo: this.echo,
            cell: this.cell,
            prompt: this.prompt,
            zones: this.zones,
        };
    }
}
