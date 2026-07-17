import type { Cell } from "./cell";
import type { Echo } from "./echo";
import type { Prompt } from "./prompt";
import { type Zone, zoneMap } from "./zone";

export class Post {
    parent?: Post;

    echo: Echo;
    cell: Cell | null = null;
    prompt: Prompt | null = null;
    zones: Record<string, Zone> = {};

    constructor(args: { echo: Echo; zones?: Record<string, Zone>; parent?: Post }) {
        this.echo = args.echo;
        this.zones = args.zones ?? {};
        this.parent = args.parent;
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

    toJSON() {
        return {
            echo: this.echo,
            cell: this.cell,
            prompt: this.prompt,
            zones: this.zones,
        };
    }
}
