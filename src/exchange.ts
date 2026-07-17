import type { Cell } from "./cell";
import type { Echo } from "./echo";
import type { Prompt } from "./prompt";
import { type Zone, zoneMap } from "./zone";

export class ComponentData {
    echo: Echo | null = null;
    cell: Cell | null = null;
    prompt: Prompt | null = null;
    zones: Record<string, Zone> = {};

    constructor(zones?: Record<string, Zone>) {
        this.zones = zones ?? {};
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
}
