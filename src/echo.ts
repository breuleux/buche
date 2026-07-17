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

/** Whether the echo's process can still receive signals (kill, resize, ...). */
export function killable(echo: Echo): boolean {
    return echo.status.status === "running" || echo.status.status === "unresponsive";
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
    views?: Set<ViewLabel>;

    constructor(config: EchoConfiguration & CreationInfo) {
        super();
        this.views = new Set();
        this.status = { status: "absent" };
        this.address = config.from;
        this.configure(config);
    }

    configure(config: EchoConfiguration) {
        this.label = config.label ?? this.label ?? `%${this.serialId}`;
        this.color = config.color ?? this.color ?? "purple";
        this.echo = config.echo ?? this.echo;
    }
}
