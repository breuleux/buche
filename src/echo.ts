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

    /**
     * The id of the user command this echo answers (repeated from the
     * "command" request's `id`). The interface uses it to give the focus to
     * the echo's element when it appears.
     */
    id?: string;

    /** If true, keep the focus on the cell when its process ends. */
    sticky?: boolean;

    /** If true, do not automatically focus the cell or prompt. */
    background?: boolean;
}

/** The DOM id of the element showing the echo answering command `id`. */
export function echoElementId(id: string): string {
    return `echo-${id}`;
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

    /** The id of the user command this echo answers, if any. */
    id?: string;

    /** If true, keep the focus on the cell when its process ends. */
    sticky = false;

    /** If true, do not automatically focus the cell or prompt. */
    background = false;

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
        this.id = config.id ?? this.id;
        this.sticky = config.sticky ?? this.sticky;
        this.background = config.background ?? this.background;
    }
}
