import type { ComponentStatus } from "./cell.ts";
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
    /** Text of the command */
    echo?: StyledText;

    /** The cell/tab label. */
    label!: string;

    /** Accent color for the component. */
    color!: Accent;

    /** Status of the component. */
    status: ComponentStatus;

    /** List of views. */
    views?: Set<string>;

    constructor(config: EchoConfiguration) {
        super();
        this.views = new Set();
        this.status = { status: "running" };
        this.configure(config);
    }

    configure(config: EchoConfiguration) {
        this.label = config.label ?? `%${this.serialId}`;
        this.color = config.color ?? "purple";
        this.echo = config.echo;
    }
}
