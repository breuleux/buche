import type { CreationInfo } from "./driver-exchange/common.ts";
import type { Accent, Address, StyledText } from "./types.ts";
import { WithId } from "./utils.ts";

export type StatusString = "absent" | "running" | "done" | "error" | "unresponsive" | "standby";

export interface Status {
    status: StatusString;
    code?: number | string | null;
}

export interface EchoConfiguration {
    /** Text of the command */
    echo?: StyledText;

    /** The cell/tab label. */
    label?: string;

    /** Accent color for the component. */
    color?: Accent;
}

export type ViewLabel = "pty" | "gui";

export class Echo extends WithId() {
    /** Text of the command */
    echo?: StyledText;

    /** The cell/tab label. */
    label!: string;

    /** Accent color for the component. */
    color!: Accent;

    /** Address of the component. */
    address: Address;

    /** Status of the component. */
    status: Status;

    /** List of views. */
    views?: Set<ViewLabel>;

    /** Listeners */
    listeners: Array<(echo: this) => void> = [];

    constructor(config: EchoConfiguration & CreationInfo) {
        super();
        this.views = new Set();
        this.status = { status: "absent" };
        this.address = config.from;
        this.configure(config);
    }

    configure(config: EchoConfiguration) {
        this.label = config.label ?? `%${this.serialId}`;
        this.color = config.color ?? "purple";
        this.echo = config.echo;
    }

    fire() {
        for (const listener of this.listeners) {
            listener(this);
        }
    }
}
