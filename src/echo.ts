import type { ComponentStatus } from "./cell.ts";
import type { Prompt } from "./prompt.ts";
import type { Accent, StyledText } from "./types.ts";
import { WithId } from "./utils.ts";

export interface EchoConfiguration {
    /** Text of the command */
    echo?: StyledText;

    /** The cell/tab label. */
    label?: string;

    /** Accent color for the component. */
    color?: Accent;
}

export class Echo extends WithId() {
    /** The originating prompt. */
    prompt: Prompt | null = null;

    /** Text of the command */
    echo?: StyledText;

    /** The cell/tab label. */
    label: string;

    /** Accent color for the component. */
    color: Accent;

    /** Status of the component. */
    status: ComponentStatus;

    /** List of views. */
    views?: Set<string>;

    constructor(config: EchoConfiguration, location: { prompt: Prompt | null }) {
        super();
        this.prompt = location.prompt;
        this.label = config.label ?? `%${this.serialId}`;
        this.color = config.color ?? "purple";
        this.echo = config.echo;
        this.status = { status: "running" };
        this.views = new Set();
    }
}
