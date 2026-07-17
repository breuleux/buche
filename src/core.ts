import { Cell, CellConfiguration } from "./cell";

export interface BucheConfig {
    cellTypes: Record<string, new (config: CellConfiguration) => Cell>;
}

export class Buche implements BucheConfig {
    cellTypes!: Record<string, new (config: CellConfiguration) => Cell>;

    cells: Record<string, Cell> = {};

    constructor(config: BucheConfig) {
        Object.assign(this, config);
    }
}
