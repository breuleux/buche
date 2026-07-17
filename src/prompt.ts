
export type PromptBindings = Record<string, string>;

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

export class Prompt implements PromptConfiguration {
    label?: string | null;
    bindings?: PromptBindings;
    color?: PromptColor;
    prompt_html?: string;

    constructor(config: PromptConfiguration) {
        this.configure(config);
    }
    configure(config: PromptConfiguration): void {
        Object.assign(this, config);
    };
}
