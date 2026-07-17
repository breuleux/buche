/** The data (non-method) properties of T. */
type Fields<T> = { [K in keyof T as T[K] extends Function ? never : K]: T[K] };

export interface CellConfiguration {
  /** The cell/tab label. */
  label?: string | null;

  /** Toggle whether the cell persists after its process closes. */
  sticky?: boolean;

  /** If true, unfocus the cell and return focus to its zone. */
  background?: boolean;
}

export interface Cell {
    constructor(config: CellConfiguration): void;
    configure(config: CellConfiguration): void;
}

/**
 * Prompt key bindings, as a `{ "keyChord": actionName }` map
 * (e.g. `{ "Tab Tab": "complete" }`). The prompt turns this into
 * `{key, name}` entries.
 */
export type PromptBindings = Record<string, string>;

/** Prompt accent color, expressed in the OKLCH color space. */
export interface PromptColor {
  /** OKLCH hue */
  hue?: number;

  /** OKLCH chroma */
  chroma?: number;
}

export interface PromptConfiguration {
  /** The prompt/tab label. */
  label?: string | null;

  /** Key-chord → action-name map for this prompt. */
  bindings?: PromptBindings;

  /** Accent color for the prompt. */
  color?: PromptColor;

  /** HTML for the prompt's leading label/marker. */
  prompt_html?: string;
}

export class Prompt {
    constructor(config: PromptConfiguration) {
        this.configure(config);
    }
    configure(config: PromptConfiguration): void {

    };
}

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
