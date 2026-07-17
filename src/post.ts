import type { Cell } from "./cell";
import { Echo } from "./echo";
import type { Prompt } from "./prompt";
import { Hierarchy, type HierarchyArgs } from "./utils";
import { type Zone, zoneMap } from "./zone";

interface PostArgs extends HierarchyArgs {
    zones?: Record<string, Zone>;
}

export class Post extends Hierarchy {
    echo: Echo;
    cell: Cell | null = null;
    prompt: Prompt | null = null;
    zones: Record<string, Zone> = {};

    constructor(args: PostArgs) {
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

    toJSON() {
        return {
            echo: this.echo,
            cell: this.cell,
            prompt: this.prompt,
            zones: this.zones,
        };
    }
}
