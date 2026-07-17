import type { CreationInfo } from "./driver-exchange/common.ts";
import type { Accent, Address, StyledText } from "./types.ts";
import { WithId } from "./utils.ts";

export interface Status {
    status: "absent" | "running" | "standby" | "done" | "error" | "unresponsive";
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
    views?: Set<string>;

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
}
